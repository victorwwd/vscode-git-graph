import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataSource } from './dataSource';
import { ExtensionState } from './extensionState';
import { Logger } from './logger';
import {
	ErrorInfo,
	RebaseControlAction,
	RebaseLiveStateKind,
	RebaseLiveStatus,
	RebasePlanItem,
	RebaseSessionState,
	ResponseRebasePrompt
} from './types';

interface ActiveRebaseStatus {
	readonly state: 'running' | 'conflict' | 'edit-stopped';
	readonly progress: { readonly done: number; readonly total: number; readonly currentOid: string | null } | null;
	readonly conflicts: ReadonlyArray<string>;
}

export interface RebaseStartResult {
	readonly error: ErrorInfo;
	readonly status: RebaseLiveStatus;
}

/**
 * Owns the lifecycle of an interactive rebase: validates preconditions, prepares
 * artifacts for the rebase editor script, drives `git rebase` via DataSource, and
 * persists the session so it can be resumed across extension reactivations.
 */
export class RebaseSession {
	private readonly dataSource: DataSource;
	private readonly state: ExtensionState;
	private readonly extensionPath: string;
	private readonly logger: Logger;
	private promptWatchers: { [repo: string]: fs.FSWatcher } = {};
	private promptPollers: { [repo: string]: ReturnType<typeof setInterval> } = {};
	private messageEditorPending: { [repo: string]: boolean } = {};
	private promptNotifier: ((message: ResponseRebasePrompt) => void) | null = null;
	private promptResolvers: { [promptId: string]: (response: { accepted: boolean; message: string }) => void } = {};
	private nextPromptId: number = 1;
	private gitBusyCount: number = 0;

	constructor(dataSource: DataSource, state: ExtensionState, extensionPath: string, logger: Logger) {
		this.dataSource = dataSource;
		this.state = state;
		this.extensionPath = extensionPath;
		this.logger = logger;
	}

	/**
	 * Whether a `git rebase` child process owned by this session is currently
	 * running. While true, other Git Graph components must not spawn git
	 * commands that touch `.git/index` (e.g. `git status`): on Windows the
	 * rebase atomically renames index.lock -> index, and a concurrent reader
	 * without FILE_SHARE_DELETE makes that rename fail with "Unable to write
	 * new index file", killing the rebase step mid-flight.
	 */
	public isGitBusy(): boolean {
		return this.gitBusyCount > 0;
	}

	/**
	 * Mark the window in which this session has a git rebase child process
	 * alive. Nested/drive-by calls are counted so overlapping windows resolve
	 * only when the outermost one ends.
	 */
	private async withGitBusy<T>(run: () => Promise<T>): Promise<T> {
		this.gitBusyCount++;
		try {
			return await run();
		} finally {
			this.gitBusyCount--;
		}
	}

	/**
	 * Register the function used to push prompt messages to the webview. The
	 * view layer wires this up after creating the session.
	 */
	public setPromptNotifier(notifier: ((message: ResponseRebasePrompt) => void) | null): void {
		this.promptNotifier = notifier;
	}

	/**
	 * Deliver a webview response to a pending commit-message prompt.
	 */
	public resolvePromptResponse(promptId: string, accepted: boolean, message: string): void {
		const resolver = this.promptResolvers[promptId];
		if (!resolver) {
			this.logger.log('[rebase] prompt response for unknown id ' + promptId + ' (already resolved?)');
			return;
		}
		delete this.promptResolvers[promptId];
		resolver({ accepted, message });
	}

	/**
	 * Begin an interactive rebase. Returns the live status after the initial git invocation
	 * exits (which may be completion, conflict pause, or edit pause).
	 */
	public async start(repo: string, base: string, plan: ReadonlyArray<RebasePlanItem>): Promise<RebaseStartResult> {
		if (plan.length === 0) {
			return this.failed('Plan is empty.');
		}
		let clean: boolean;
		let detached: boolean;
		let existing: { state: 'idle' | 'running' | 'conflict' | 'edit-stopped' };
		let origHead: string;
		try {
			[clean, detached, existing, origHead] = await Promise.all([
				this.dataSource.isWorkingTreeClean(repo),
				this.dataSource.isDetachedHead(repo),
				this.dataSource.getRebaseStatus(repo),
				this.dataSource.resolveRef(repo, 'HEAD')
			]);
		} catch (err) {
			return this.failed('Failed to inspect repository: ' + (err as Error).message);
		}
		if (!clean) {
			return this.failed('Working tree has uncommitted changes. Stash or commit them first.');
		}
		if (detached) {
			return this.failed('HEAD is detached. Check out a branch first.');
		}
		if (existing.state !== 'idle') {
			return this.failed('A rebase is already in progress. Continue or abort it first.');
		}

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-rebase-'));
		this.writeArtifacts(tmpDir, plan);

		const session: RebaseSessionState = { repo, base, origHead, plan, tmpDir, startedAt: Date.now() };
		await this.state.setRebaseSession(repo, session);
		this.startPromptWatcher(repo, session);

		const env = this.buildEnv(tmpDir);
		const error = await this.withGitBusy(() => this.dataSource.startInteractiveRebase(repo, base, env));
		const status = await this.computeStatusAfterRun(repo, session, error);
		if (status.state === RebaseLiveStateKind.Completed || status.state === RebaseLiveStateKind.Aborted) {
			await this.state.clearRebaseSession(repo);
			this.stopPromptWatcher(repo);
			this.cleanupTmpDir(tmpDir);
		}
		return { error, status };
	}

	/**
	 * Handle a control action (continue / skip / abort / amendContinue / undo) on the
	 * tracked session for this repo.
	 */
	public async control(repo: string, action: RebaseControlAction): Promise<RebaseStartResult> {
		this.logger.log('[rebase] control start: action=' + action + ' repo=' + repo);
		// Abort and Undo are escape hatches — always allow them through, even
		// when a commit-message prompt is still pending in the webview (the
		// user may be trying to bail out precisely because the prompt is stuck).
		const isEscapeHatch = action === RebaseControlAction.Abort || action === RebaseControlAction.Undo;
		if (this.messageEditorPending[repo] && !isEscapeHatch) {
			this.logger.log('[rebase] control rejected: a commit-message prompt is still open for this repo');
			const status = await this.query(repo);
			return { error: 'A commit message prompt is still open. Confirm or cancel it before retrying. Use Abort to bail out.', status };
		}
		const session = this.state.getRebaseSession(repo);
		if (!session) {
			this.logger.log('[rebase] control: no tracked session');
			return this.failed('No tracked rebase session for this repository.');
		}
		const env = this.buildEnv(session.tmpDir);
		let error: ErrorInfo = null;
		switch (action) {
			case RebaseControlAction.Continue:
				error = await this.withGitBusy(() => this.dataSource.rebaseContinue(repo, env));
				break;
			case RebaseControlAction.AmendContinue:
				error = await this.withGitBusy(() => this.dataSource.rebaseAmendContinue(repo, env));
				break;
			case RebaseControlAction.AmendRewordContinue: {
				const prep = await this.prepareRewordMessage(repo, session);
				if (prep.error !== null) {
					return { error: prep.error, status: await this.computeStatusAfterRun(repo, session, prep.error) };
				}
				error = await this.withGitBusy(() => this.dataSource.rebaseAmendRewordContinue(repo, prep.msgPath, env));
				break;
			}
			case RebaseControlAction.Skip:
				error = await this.withGitBusy(() => this.dataSource.rebaseSkip(repo));
				break;
			case RebaseControlAction.Abort:
				error = await this.withGitBusy(() => this.dataSource.rebaseAbort(repo));
				await this.state.clearRebaseSession(repo);
				this.stopPromptWatcher(repo);
				this.cleanupTmpDir(session.tmpDir);
				return { error, status: this.idleStatus(session.origHead, false) };
			case RebaseControlAction.Undo:
				error = await this.withGitBusy(() => this.dataSource.undoLastRebase(repo, session.origHead));
				await this.state.clearRebaseSession(repo);
				this.stopPromptWatcher(repo);
				this.cleanupTmpDir(session.tmpDir);
				return { error, status: this.idleStatus(null, false) };
		}
		const status = await this.computeStatusAfterRun(repo, session, error);
		if (status.state === RebaseLiveStateKind.Completed || status.state === RebaseLiveStateKind.Aborted) {
			await this.state.clearRebaseSession(repo);
			this.stopPromptWatcher(repo);
			this.cleanupTmpDir(session.tmpDir);
		}
		return { error, status };
	}

	/**
	 * Query the live rebase status of a repository, reconciling persisted session
	 * state against what git reports on disk.
	 */
	public async query(repo: string): Promise<RebaseLiveStatus> {
		const session = this.state.getRebaseSession(repo);
		const [live, dirt] = await Promise.all([
			this.dataSource.getRebaseStatus(repo),
			this.dataSource.getWorkingTreeDirt(repo).catch(() => ({ worktreeDirty: false, indexDirty: false }))
		]);
		if (live.state === 'idle') {
			if (session) {
				await this.state.clearRebaseSession(repo);
				this.cleanupTmpDir(session.tmpDir);
			}
			return this.idleStatus(session ? session.origHead : null, !!session);
		}
		// The prompt watcher is in-memory only; after an extension host restart the
		// persisted session outlives it. Re-arm it here so a later Continue that
		// invokes the message editor finds a host to answer its prompt — otherwise
		// it would hang until the 10-minute timeout and fail the rebase step.
		if (session && !this.promptWatchers[repo] && !this.promptPollers[repo]) {
			this.startPromptWatcher(repo, session);
		}
		return this.toLiveStatus(repo, live as ActiveRebaseStatus, session ? session.origHead : null, dirt);
	}

	/**
	 * Inspect all known repositories and report any non-idle rebase status (or a pending
	 * "Undo" affordance) to the caller. Used at activation time to restore the status bar
	 * after a VS Code reload while a rebase is in progress.
	 */
	public async resumeAll(repos: ReadonlyArray<string>, notify: (repo: string, status: RebaseLiveStatus) => void): Promise<void> {
		for (const repo of repos) {
			try {
				const status = await this.query(repo);
				if (status.state !== RebaseLiveStateKind.Idle || status.canUndo) {
					notify(repo, status);
				}
			} catch (_) { /* repo no longer accessible; skip */ }
		}
	}

	private async computeStatusAfterRun(repo: string, session: RebaseSessionState, error: ErrorInfo): Promise<RebaseLiveStatus> {
		const [live, dirt] = await Promise.all([
			this.dataSource.getRebaseStatus(repo),
			this.dataSource.getWorkingTreeDirt(repo).catch(() => ({ worktreeDirty: false, indexDirty: false }))
		]);
		if (live.state === 'idle') {
			return {
				state: error === null ? RebaseLiveStateKind.Completed : RebaseLiveStateKind.Aborted,
				progress: null,
				conflicts: [],
				origHead: session.origHead,
				canUndo: error === null,
				worktreeDirty: dirt.worktreeDirty,
				indexDirty: dirt.indexDirty
			};
		}
		return this.toLiveStatus(repo, live as ActiveRebaseStatus, session.origHead, dirt);
	}

	private toLiveStatus(repo: string, live: ActiveRebaseStatus, origHead: string | null, dirt: { worktreeDirty: boolean; indexDirty: boolean }): RebaseLiveStatus {
		// Downgrade edit-stopped → running while a reword/squash message prompt is still open;
		// git leaves stopped-sha in place during that window, which would otherwise look like `edit`.
		const isPromptPending = !!this.messageEditorPending[repo];
		const kind = live.state === 'conflict'
			? RebaseLiveStateKind.Conflict
			: live.state === 'edit-stopped' && !isPromptPending
				? RebaseLiveStateKind.EditStopped
				: RebaseLiveStateKind.Running;
		return {
			state: kind,
			progress: live.progress,
			conflicts: live.conflicts,
			origHead,
			canUndo: false,
			worktreeDirty: dirt.worktreeDirty,
			indexDirty: dirt.indexDirty
		};
	}

	private idleStatus(origHead: string | null, canUndo: boolean): RebaseLiveStatus {
		return { state: RebaseLiveStateKind.Idle, progress: null, conflicts: [], origHead, canUndo, worktreeDirty: false, indexDirty: false };
	}

	private failed(message: string): RebaseStartResult {
		return { error: message, status: this.idleStatus(null, false) };
	}

	private writeArtifacts(tmpDir: string, plan: ReadonlyArray<RebasePlanItem>): void {
		fs.writeFileSync(path.join(tmpDir, 'plan.json'), JSON.stringify({ items: plan }));
		fs.mkdirSync(path.join(tmpDir, 'prompt'), { recursive: true });
	}

	private startPromptWatcher(repo: string, session: RebaseSessionState): void {
		const promptDir = path.join(session.tmpDir, 'prompt');
		const checkForPrompt = () => {
			if (this.messageEditorPending[repo]) return;
			// response.txt present means we already answered; rebaseEditor hasn't
			// consumed it yet. Skip to avoid re-entry until it cleans up.
			const responsePath = path.join(promptDir, 'response.txt');
			if (fs.existsSync(responsePath)) return;
			const waitingPath = path.join(promptDir, 'waiting');
			if (!fs.existsSync(waitingPath)) return;
			const requestPath = path.join(promptDir, 'request.txt');
			let msgPath = '';
			try { msgPath = fs.readFileSync(requestPath, 'utf8').trim(); } catch (_) { return; }
			if (msgPath) {
				this.logger.log('[rebase] prompt: editor request received, msgPath=' + msgPath);
				this.handleGitEditorPrompt(repo, session, msgPath);
			}
		};

		try {
			const watcher = fs.watch(promptDir, { persistent: false }, (eventType, filename) => {
				this.logger.log('[rebase] prompt: watcher event: eventType=' + eventType + ' filename=' + (filename || '(null)'));
				checkForPrompt();
			});
			this.promptWatchers[repo] = watcher;
		} catch (_) { /* tmpDir missing or unwatchable; polling fallback will still run */ }

		// Polling fallback: fs.watch is known to miss events on some Windows/Node
		// combinations. Unref'd so it doesn't keep the extension host alive.
		const pollTimer = setInterval(checkForPrompt, 200);
		pollTimer.unref();
		this.promptPollers[repo] = pollTimer;
	}

	/**
	 * Git is blocked waiting on a commit message via the rebase-editor helper.
	 * Read the default contents, ask the webview via {@link promptForMessage}
	 * for the user's choice, then write the response file to release git.
	 * If the user cancels (or no webview is connected) rebaseEditor exits
	 * non-zero so git aborts the rebase instead of proceeding.
	 */
	private async handleGitEditorPrompt(repo: string, session: RebaseSessionState, msgPath: string): Promise<void> {
		this.messageEditorPending[repo] = true;
		let defaultMessage = '';
		try {
			defaultMessage = fs.readFileSync(msgPath, 'utf8');
		} catch (err) {
			this.logger.logError('[rebase] prompt: failed to read msgPath: ' + (err as Error).message);
		}

		const { accepted, message } = await this.promptForMessage(repo, defaultMessage);
		// response.txt is a JSON envelope so rebaseEditor can distinguish
		// accept (write the edited message) from cancel (write defaultMessage
		// unchanged — "Cancel keeps the original message" as the dialog promises;
		// exiting non-zero would make git treat the editor as crashed and pause
		// the rebase in an amend state the UI misreports as edit-stopped).
		const response = JSON.stringify({ accepted, message: accepted ? message : defaultMessage });
		this.logger.log('[rebase] prompt: writing response (accepted=' + accepted + ', bytes=' + response.length + ')');

		// Atomic publish: write a sibling temp file then rename. fs.writeFileSync is not
		// atomic on Windows, and rebaseEditor polls/watches this file — a partial write
		// would make its JSON.parse throw and abort the rebase step mid-flight.
		const promptDir = path.join(session.tmpDir, 'prompt');
		const finalPath = path.join(promptDir, 'response.txt');
		const tmpPath = path.join(promptDir, '.response.tmp.' + process.pid);
		try {
			fs.writeFileSync(tmpPath, response);
			fs.renameSync(tmpPath, finalPath);
		} catch (err) {
			this.logger.logError('[rebase] prompt: failed to write response.txt: ' + (err as Error).message);
			try { fs.unlinkSync(tmpPath); } catch (_) { /* temp already gone */ }
		}
		delete this.messageEditorPending[repo];
	}

	/**
	 * Ask the webview for a commit message. Resolves with what the user
	 * submitted. If no webview is connected, resolves immediately with the
	 * default message so git can proceed unchanged.
	 */
	private promptForMessage(repo: string, defaultMessage: string): Promise<{ accepted: boolean; message: string }> {
		if (this.promptNotifier === null) {
			this.logger.log('[rebase] prompt: no notifier registered; auto-confirming default message');
			return Promise.resolve({ accepted: true, message: defaultMessage });
		}
		const promptId = 'rp-' + (this.nextPromptId++) + '-' + Date.now();
		return new Promise((resolve) => {
			this.promptResolvers[promptId] = resolve;
			try {
				this.promptNotifier!({
					command: 'rebasePrompt',
					repo,
					promptId,
					defaultMessage
				});
			} catch (err) {
				this.logger.logError('[rebase] prompt: notifier threw: ' + (err as Error).message);
				delete this.promptResolvers[promptId];
				resolve({ accepted: true, message: defaultMessage });
			}
		});
	}

	private stopPromptWatcher(repo: string): void {
		const watcher = this.promptWatchers[repo];
		if (watcher) {
			watcher.close();
			delete this.promptWatchers[repo];
		}
		const poller = this.promptPollers[repo];
		if (poller) {
			clearInterval(poller);
			delete this.promptPollers[repo];
		}
		delete this.messageEditorPending[repo];
	}

	/**
	 * Remove the session's temp directory (plan, prompt protocol files, editor log).
	 * Best-effort: a locked file (antivirus, editor still exiting) is logged and
	 * left behind rather than failing the rebase completion path.
	 */
	private cleanupTmpDir(tmpDir: string): void {
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch (err) {
			this.logger.log('[rebase] tmpDir cleanup failed for ' + tmpDir + ': ' + (err as Error).message);
		}
	}

	/**
	 * Prepare a commit message file for the amend+reword flow. Reads HEAD's
	 * current message, asks the webview for the new text, writes it to
	 * `<tmpDir>/reword/COMMIT_EDITMSG`, and returns the path so the caller
	 * can pass it to `git commit --amend -F <msgPath>`. Cancelling the prompt
	 * keeps the current message (as the dialog states) and still amends.
	 */
	private async prepareRewordMessage(repo: string, session: RebaseSessionState): Promise<{ error: ErrorInfo; msgPath: string }> {
		let current: string;
		try {
			current = await this.dataSource.getCommitMessage(repo, 'HEAD');
		} catch (err) {
			return { error: 'Failed to read current commit message: ' + (err as Error).message, msgPath: '' };
		}

		const { message } = await this.promptForMessage(repo, current);

		const rewordDir = path.join(session.tmpDir, 'reword');
		const msgPath = path.join(rewordDir, 'COMMIT_EDITMSG');
		try {
			fs.mkdirSync(rewordDir, { recursive: true });
			fs.writeFileSync(msgPath, message);
		} catch (err) {
			return { error: 'Failed to stage commit message: ' + (err as Error).message, msgPath: '' };
		}

		return { error: null, msgPath };
	}

	private buildEnv(tmpDir: string): NodeJS.ProcessEnv {
		// Use forward slashes everywhere: git for Windows invokes GIT_EDITOR /
		// GIT_SEQUENCE_EDITOR via `sh -c`, where backslashes in Windows paths are
		// interpreted as escape characters and break command parsing, causing git
		// to fall back to core.editor (typically VS Code's built-in git integration).
		const toFwd = (p: string) => p.replace(/\\/g, '/');
		const editor = toFwd(path.join(this.extensionPath, 'out', 'rebaseEditor', 'main.js'));
		const planPath = toFwd(path.join(tmpDir, 'plan.json'));
		const msgDir = toFwd(path.join(tmpDir, 'msg'));
		const logPath = toFwd(path.join(tmpDir, 'editor.log'));
		const node = toFwd(process.execPath);
		const env = {
			ELECTRON_RUN_AS_NODE: '1',
			GIT_SEQUENCE_EDITOR: '"' + node + '" "' + editor + '" todo "' + planPath + '"',
			GIT_EDITOR: '"' + node + '" "' + editor + '" msg "' + msgDir + '"',
			REBASE_EDITOR_LOG: logPath
		};
		this.logger.log('[rebase] buildEnv: GIT_SEQUENCE_EDITOR=' + env.GIT_SEQUENCE_EDITOR);
		this.logger.log('[rebase] buildEnv: GIT_EDITOR=' + env.GIT_EDITOR);
		return env;
	}
}
