import * as vscode from 'vscode';
import { getPathFromStr, getPathFromUri, samePath } from './utils';
import { GitWorktree } from './types';

/**
 * Parse the output of `git worktree list --porcelain` into a list of worktrees.
 *
 * The porcelain format groups worktrees into blocks separated by blank lines.
 * Each block contains lines such as `worktree <path>`, `HEAD <sha>`,
 * `branch refs/heads/<name>`, `detached`, `bare`, `locked [<reason>]`,
 * `prunable [<reason>]`. Reasons may contain spaces and colons, so they cannot
 * be split on whitespace. The first block is always the main/primary worktree.
 *
 * @param stdout The raw stdout from `git worktree list --porcelain`.
 * @returns The parsed worktrees (first entry is the main worktree).
 */
export function parseWorktreePorcelain(stdout: string): Omit<GitWorktree, 'isCurrent'>[] {
	return stdout.split(/\r?\n\r?\n/)
		.map(block => block.trim())
		.filter(block => block.length > 0)
		.map(block => {
			const lines = block.split(/\r?\n/);
			let wtPath = '', headHash: string | null = null, branch: string | null = null;
			let isBare = false, isDetached = false;
			let isLocked = false, lockReason: string | null = null;
			let isPrunable = false, prunableReason: string | null = null;

			for (const line of lines) {
				if (line.startsWith('worktree ')) {
					wtPath = getPathFromStr(line.substring(9));
				} else if (line.startsWith('HEAD ')) {
					headHash = line.substring(5);
				} else if (line.startsWith('branch ')) {
					branch = line.substring(7).replace(/^refs\/heads\//, '');
				} else if (line === 'bare') {
					isBare = true;
				} else if (line === 'detached') {
					isDetached = true;
				} else if (line === 'locked') {
					isLocked = true;
				} else if (line.startsWith('locked ')) {
					isLocked = true;
					lockReason = line.substring(7);
				} else if (line === 'prunable') {
					isPrunable = true;
				} else if (line.startsWith('prunable ')) {
					isPrunable = true;
					prunableReason = line.substring(9);
				}
			}

			return {
				path: wtPath,
				headHash,
				branch,
				isMain: false,
				isBare,
				isDetached,
				isLocked,
				lockReason,
				isPrunable,
				prunableReason
			};
		})
		.map((wt, i) => ({ ...wt, isMain: i === 0 })); // git guarantees the first entry is the main worktree
}

/**
 * Parse the output of `git worktree prune -v --dry-run` into a list of worktree
 * entry names that would be pruned.
 *
 * The output is one line per prunable entry, in the form:
 *   `Removing worktrees/<name>: <reason>`
 *
 * @param stdout The raw stdout from `git worktree prune -v --dry-run`.
 * @returns The list of `<name>` (or `worktrees/<name>`) strings that would be pruned.
 */
export function parsePruneDryRunOutput(stdout: string): string[] {
	return stdout.split(/\r?\n/)
		.map(line => line.trim())
		.filter(line => line.startsWith('Removing '))
		.map(line => {
			const rest = line.substring('Removing '.length);
			return rest.split(':')[0]; // e.g. "worktrees/<name>"
		})
		.filter(name => name.length > 0);
}

/**
 * User-facing message shown when a worktree's target path already exists on disk.
 *
 * Shared between the proactive pre-check (before `git worktree add` is run) and
 * the reactive translation of git's own `already exists` stderr, so the two code
 * paths can never diverge in wording.
 */
export const WORKTREE_PATH_EXISTS_MSG = 'The target path already exists and is not empty. Choose another location or clear the directory first.';

/**
 * The result of translating a raw Git worktree stderr into a user-facing message.
 */
export interface TranslatedWorktreeError {
	readonly message: string;
	readonly conflictWorktreePath: string | null;
}

/**
 * Translate a raw stderr from a `git worktree` subcommand into a user-facing
 * message, extracting a conflicting worktree path when one is present (e.g.
 * when a branch is already checked out in another worktree).
 *
 * @param stderr The raw stderr from Git.
 * @returns The translated message and, if applicable, the conflict worktree path (normalised to forward slashes).
 */
export function translateWorktreeError(stderr: string): TranslatedWorktreeError {
	// Branch already checked out in another worktree.
	// Real git output: "... '<branch>' is already used by worktree at '<path>'"
	const conflictMatch = stderr.match(/is already used by worktree at '([^']+)'/);
	if (conflictMatch) {
		return {
			message: 'This branch is already checked out in another worktree: ' + conflictMatch[1],
			conflictWorktreePath: getPathFromStr(conflictMatch[1])
		};
	}

	// Target path already exists.
	if (/already exists/.test(stderr)) {
		return { message: WORKTREE_PATH_EXISTS_MSG, conflictWorktreePath: null };
	}

	// Worktree is locked. Real git output: "fatal: cannot remove a locked working tree, lock reason: ..."
	if (/locked working tree|is locked/.test(stderr)) {
		return { message: 'This worktree is locked. Unlock it before performing this action.', conflictWorktreePath: null };
	}

	// Uncommitted changes present on remove.
	if (/contains modified or untracked files/.test(stderr)) {
		return { message: 'This worktree contains uncommitted changes. Force removing will permanently lose them.', conflictWorktreePath: null };
	}

	return { message: stderr, conflictWorktreePath: null };
}

/**
 * Check whether a worktree path is the folder currently open as a VS Code workspace
 * root. Used to forbid removing/moving the worktree the user is actively working in.
 *
 * @param worktreePath The absolute worktree path (already normalised to forward slashes).
 * @returns TRUE => the path is the current workspace root, FALSE => it is not.
 */
export function isCurrentWorkspaceWorktree(worktreePath: string): boolean {
	const folders = vscode.workspace.workspaceFolders || [];
	return folders.some(f => samePath(getPathFromUri(f.uri), worktreePath));
}
