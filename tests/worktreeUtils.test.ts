import * as vscode from './mocks/vscode';
jest.mock('vscode', () => vscode, { virtual: true });

import { isCurrentWorkspaceWorktree, parsePruneDryRunOutput, parseWorktreePorcelain, translateWorktreeError } from '../src/worktreeUtils';

describe('worktreeUtils', () => {

	describe('parseWorktreePorcelain', () => {
		it('parses a main worktree with a branch', () => {
			const stdout = 'worktree C:/repo/main\nHEAD 962554fe917296306e5dffc59d83bd0f7d438c27\nbranch refs/heads/master\n';
			const result = parseWorktreePorcelain(stdout);
			expect(result).toHaveLength(1);
			expect(result[0]).toEqual({
				path: 'C:/repo/main',
				headHash: '962554fe917296306e5dffc59d83bd0f7d438c27',
				branch: 'master',
				isMain: true,
				isBare: false,
				isDetached: false,
				isLocked: false,
				lockReason: null,
				isPrunable: false,
				prunableReason: null
			});
		});

		it('parses multiple worktrees and marks only the first as main', () => {
			const stdout = [
				'worktree C:/repo/main',
				'HEAD aaa',
				'branch refs/heads/master',
				'',
				'worktree C:/repo/wt-feature',
				'HEAD bbb',
				'branch refs/heads/feature-x',
				''
			].join('\n');
			const result = parseWorktreePorcelain(stdout);
			expect(result).toHaveLength(2);
			expect(result[0].isMain).toBe(true);
			expect(result[0].path).toBe('C:/repo/main');
			expect(result[1].isMain).toBe(false);
			expect(result[1].branch).toBe('feature-x');
		});

		it('parses a detached worktree (no branch line)', () => {
			const stdout = 'worktree C:/repo/wt-det\nHEAD ccc\ndetached\n';
			const result = parseWorktreePorcelain(stdout);
			expect(result[0].isDetached).toBe(true);
			expect(result[0].branch).toBeNull();
		});

		it('parses locked with a reason containing spaces', () => {
			const stdout = 'worktree C:/repo/wt\nHEAD ddd\nbranch refs/heads/x\nlocked doing some long running task\n';
			const result = parseWorktreePorcelain(stdout);
			expect(result[0].isLocked).toBe(true);
			expect(result[0].lockReason).toBe('doing some long running task');
		});

		it('parses prunable with a reason containing a colon', () => {
			const stdout = 'worktree C:/repo/wt\nHEAD eee\ndetached\nprunable gitdir file points to non-existent location\n';
			const result = parseWorktreePorcelain(stdout);
			expect(result[0].isPrunable).toBe(true);
			expect(result[0].prunableReason).toBe('gitdir file points to non-existent location');
		});

		it('parses locked without a reason', () => {
			const stdout = 'worktree C:/repo/wt\nHEAD fff\nbranch refs/heads/x\nlocked\n';
			const result = parseWorktreePorcelain(stdout);
			expect(result[0].isLocked).toBe(true);
			expect(result[0].lockReason).toBeNull();
		});

		it('handles CRLF line endings and trailing blank lines', () => {
			const stdout = 'worktree C:/repo/main\r\nHEAD aaa\r\nbranch refs/heads/master\r\n\r\n';
			const result = parseWorktreePorcelain(stdout);
			expect(result).toHaveLength(1);
			expect(result[0].branch).toBe('master');
		});

		it('normalises backslash paths to forward slashes', () => {
			const stdout = 'worktree C:\\repo\\main\nHEAD aaa\nbranch refs/heads/master\n';
			const result = parseWorktreePorcelain(stdout);
			expect(result[0].path).toBe('C:/repo/main');
		});
	});

	describe('parsePruneDryRunOutput', () => {
		it('parses Removing lines into worktree entry names', () => {
			const stdout = [
				'Removing worktrees/wt-det: gitdir file points to non-existent location',
				'Removing worktrees/wt-other: another reason'
			].join('\n');
			expect(parsePruneDryRunOutput(stdout)).toEqual(['worktrees/wt-det', 'worktrees/wt-other']);
		});

		it('returns empty for blank output', () => {
			expect(parsePruneDryRunOutput('')).toEqual([]);
		});

		it('filters out non-Removing lines', () => {
			const stdout = 'Removing worktrees/wt1: reason\nSome other line\nRemoving worktrees/wt2: reason2\n';
			expect(parsePruneDryRunOutput(stdout)).toEqual(['worktrees/wt1', 'worktrees/wt2']);
		});
	});

	describe('translateWorktreeError', () => {
		it('extracts the conflict worktree path from a real "already used by worktree" stderr', () => {
			const stderr = 'fatal: \'feature-x\' is already used by worktree at \'C:/Users/me/repo/wt-feature\'';
			const result = translateWorktreeError(stderr);
			expect(result.conflictWorktreePath).toBe('C:/Users/me/repo/wt-feature');
			expect(result.message).toContain('already checked out in another worktree');
		});

		it('translates an "already exists" target path error', () => {
			const result = translateWorktreeError('fatal: \'/path/x\' already exists');
			expect(result.conflictWorktreePath).toBeNull();
			expect(result.message).toContain('already exists');
		});

		it('translates an uncommitted changes error', () => {
			const result = translateWorktreeError('fatal: \'/path/x\' contains modified or untracked files, use --force to delete it');
			expect(result.message).toContain('uncommitted changes');
		});

		it('translates a locked worktree error', () => {
			const result = translateWorktreeError('fatal: cannot remove a locked working tree, lock reason: x');
			expect(result.message).toContain('locked');
		});

		it('returns the raw stderr when no pattern matches', () => {
			const result = translateWorktreeError('some unknown git error');
			expect(result.message).toBe('some unknown git error');
			expect(result.conflictWorktreePath).toBeNull();
		});
	});

	describe('isCurrentWorkspaceWorktree', () => {
		beforeEach(() => {
			vscode.workspace.workspaceFolders = undefined;
		});

		it('returns false when there are no workspace folders', () => {
			expect(isCurrentWorkspaceWorktree('C:/repo/wt')).toBe(false);
		});

		it('returns true when the path matches a workspace folder', () => {
			vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file('C:/repo/wt'), index: 0 }];
			expect(isCurrentWorkspaceWorktree('C:/repo/wt')).toBe(true);
		});

		it('returns false when the path does not match', () => {
			vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file('C:/repo/other'), index: 0 }];
			expect(isCurrentWorkspaceWorktree('C:/repo/wt')).toBe(false);
		});
	});
});
