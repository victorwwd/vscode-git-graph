import * as path from 'path';
import * as vscode from 'vscode';
import { Logger } from './logger';
import { getPathFromUri } from './utils';

const FILE_CHANGE_REGEX = /(^\.git\/(config|index|HEAD|refs\/stash|refs\/heads\/.*|refs\/remotes\/.*|refs\/tags\/.*)$)|(^(?!\.git).*$)|(^\.git[^\/]+$)/;

const IS_WINDOWS = process.platform === 'win32';

/**
 * Minimal type definitions for the VS Code built-in Git extension API
 * (`vscode.git`). Only the subset needed for subscribing to repo events is
 * declared here.
 */
interface GitRepositoryState {
	readonly onDidChange: vscode.Event<void>;
}

interface GitRepository {
	readonly rootUri: vscode.Uri;
	readonly state: GitRepositoryState;
}

interface GitAPI {
	readonly repositories: GitRepository[];
	readonly onDidOpenRepository: vscode.Event<GitRepository>;
}

interface GitExtension {
	readonly enabled: boolean;
	readonly onDidChangeEnablement: vscode.Event<boolean>;
	getAPI: (version: 1) => GitAPI;
}

/**
 * Compare a repository URI from the Git extension with a repo path used by Git
 * Graph. Normalises separators and handles drive-letter case on Windows.
 */
function sameRepoPath(uri: vscode.Uri, repoPath: string): boolean {
	const a = path.normalize(getPathFromUri(uri));
	const b = path.normalize(repoPath);
	if (IS_WINDOWS) return a.toLowerCase() === b.toLowerCase();
	return a === b;
}

/**
 * Obtain the `vscode.git` extension API (null if unavailable).
 */
function getGitAPI(): GitAPI | null {
	if (!vscode.extensions) return null;
	const gitExt = vscode.extensions.getExtension<GitExtension>('vscode.git');
	if (!gitExt) return null;
	return gitExt.isActive ? gitExt.exports.getAPI(1) : null;
}

/**
 * Find a Repository tracked by the git extension whose root matches `repoPath`.
 */
function findGitRepo(api: GitAPI, repoPath: string): GitRepository | undefined {
	return api.repositories.find((r) => sameRepoPath(r.rootUri, repoPath));
}

/**
 * Subscribe to `state.onDidChange` for a repo, plus handle the case where the
 * git extension is not yet active (activate + retry) or the repo is not yet
 * registered (`onDidOpenRepository`).
 *
 * Returns a disposable whose `dispose()` method tears down ALL subscriptions
 * that were opened — including those that were established asynchronously
 * after extension activation or repo registration.
 */
function watchGitRepo(repoPath: string, callback: () => void): vscode.Disposable {
	const disposables: vscode.Disposable[] = [];
	let disposed = false;

	/**
	 * Push a disposable unless the watcher has already been disposed (in
	 * which case the subscription is immediately discarded so it does not
	 * become an orphan).
	 */
	function track(d: vscode.Disposable) {
		if (disposed) {
			d.dispose();
		} else {
			disposables.push(d);
		}
	}

	function subscribe(api: GitAPI) {
		const repo = findGitRepo(api, repoPath);
		if (repo) {
			track(repo.state.onDidChange(callback));
		} else {
			// The repo may not be registered yet.  Wait for it.
			const d = api.onDidOpenRepository((openedRepo) => {
				if (!sameRepoPath(openedRepo.rootUri, repoPath)) return;
				track(openedRepo.state.onDidChange(callback));
				d.dispose(); // one-shot
			});
			track(d);
		}
	}

	const api = getGitAPI();
	if (api) {
		subscribe(api);
	} else {
		// Git extension not active yet — activate and retry
		const gitExt = vscode.extensions.getExtension<GitExtension>('vscode.git');
		if (gitExt && !gitExt.isActive) {
			gitExt.activate().then(() => {
				if (disposed) return; // view already stopped
				const retryApi = getGitAPI();
				if (retryApi) subscribe(retryApi);
			});
		}
	}

	return {
		dispose: () => {
			disposed = true;
			disposables.forEach((d) => d.dispose());
		}
	};
}

/**
 * Watches a Git repository for file events and state changes from the built-in
 * Git extension.
 */
export class RepoFileWatcher {
	private readonly logger: Logger;
	private readonly repoChangeCallback: () => void;
	private repo: string | null = null;
	private fsWatcher: vscode.FileSystemWatcher | null = null;
	private gitDisposable: vscode.Disposable | null = null;
	private refreshTimeout: NodeJS.Timeout | null = null;
	private muted: boolean = false;
	private resumeAt: number = 0;

	/**
	 * Creates a RepoFileWatcher.
	 * @param logger The Git Graph Logger instance.
	 * @param repoChangeCallback A callback to be invoked when a file event occurs in the repository.
	 */
	constructor(logger: Logger, repoChangeCallback: () => void) {
		this.logger = logger;
		this.repoChangeCallback = repoChangeCallback;
	}

	/**
	 * Start watching a repository for file events and git state changes.
	 * @param repo The path of the repository to watch.
	 */
	public start(repo: string) {
		if (this.fsWatcher !== null) {
			// If there is an existing File System Watcher, stop it
			this.stop();
		}

		this.repo = repo;
		// Create a File System Watcher for all events within the specified repository
		this.fsWatcher = vscode.workspace.createFileSystemWatcher(repo + '/**');
		this.fsWatcher.onDidCreate(uri => this.refresh(uri));
		this.fsWatcher.onDidChange(uri => this.refresh(uri));
		this.fsWatcher.onDidDelete(uri => this.refresh(uri));
		this.logger.log('Started watching repo: ' + repo);

		// Also subscribe to the built-in Git extension's state change events
		this.gitDisposable = watchGitRepo(repo, () => this.notifyChange());
	}

	/**
	 * Stop watching the repository for file events.
	 */
	public stop() {
		if (this.fsWatcher !== null) {
			// If there is an existing File System Watcher, stop it
			this.fsWatcher.dispose();
			this.fsWatcher = null;
			this.logger.log('Stopped watching repo: ' + this.repo);
		}
		if (this.refreshTimeout !== null) {
			// If a timeout is active, clear it
			clearTimeout(this.refreshTimeout);
			this.refreshTimeout = null;
		}
		if (this.gitDisposable) {
			this.gitDisposable.dispose();
			this.gitDisposable = null;
		}
	}

	/**
	 * Mute file events - Used to prevent many file events from being triggered when a Git action is executed by the Git Graph View.
	 */
	public mute() {
		this.muted = true;
	}

	/**
	 * Unmute file events - Used to resume normal watching after a Git action executed by the Git Graph View has completed.
	 */
	public unmute() {
		this.muted = false;
		this.resumeAt = (new Date()).getTime() + 1500;
	}


	/**
	 * Handle a file event triggered by the File System Watcher.
	 * @param uri The URI of the file that the event occurred on.
	 */
	private refresh(uri: vscode.Uri) {
		if (this.muted) return;
		if (!getPathFromUri(uri).replace(this.repo + '/', '').match(FILE_CHANGE_REGEX)) return;
		if ((new Date()).getTime() < this.resumeAt) return;
		this.notifyChange();
	}

	/**
	 * Trigger a change notification (debounced).
	 */
	private notifyChange() {
		if (this.muted) return;
		if (this.refreshTimeout !== null) {
			clearTimeout(this.refreshTimeout);
		}
		this.refreshTimeout = setTimeout(() => {
			this.refreshTimeout = null;
			this.repoChangeCallback();
		}, 750);
	}
}
