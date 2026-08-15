import './mocks/date';
import { mockSpyOnSpawn } from './mocks/spawn';
import * as vscode from './mocks/vscode';
jest.mock('vscode', () => vscode, { virtual: true });
jest.mock('../src/askpass/askpassManager');
jest.mock('../src/logger');
jest.mock('fs');

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigurationChangeEvent } from 'vscode';
import { DataSource } from '../src/dataSource';
import { Logger } from '../src/logger';
import * as utils from '../src/utils';
import { EventEmitter } from '../src/utils/event';

let onDidChangeConfiguration: EventEmitter<ConfigurationChangeEvent>;
let onDidChangeGitExecutable: EventEmitter<utils.GitExecutable>;
let logger: Logger;
let spyOnSpawn: jest.SpyInstance;

beforeAll(() => {
	onDidChangeConfiguration = new EventEmitter<ConfigurationChangeEvent>();
	onDidChangeGitExecutable = new EventEmitter<utils.GitExecutable>();
	logger = new Logger();
	jest.spyOn(path, 'normalize').mockImplementation((p) => p);
	spyOnSpawn = jest.spyOn(cp, 'spawn');
});

afterAll(() => {
	logger.dispose();
	onDidChangeConfiguration.dispose();
	onDidChangeGitExecutable.dispose();
});

afterEach(() => {
	jest.useRealTimers();
});

describe('DataSource - Interactive Rebase', () => {
	let dataSource: DataSource;

	beforeEach(() => {
		dataSource = new DataSource({ path: '/path/to/git', version: '2.25.0' }, onDidChangeConfiguration.subscribe, onDidChangeGitExecutable.subscribe, logger);
	});

	afterEach(() => {
		dataSource.dispose();
	});

	const mockGitSuccessOnce = (stdout?: string, stderr?: string) => {
		mockSpyOnSpawn(spyOnSpawn, (onCallbacks, stderrOnCallbacks, stdoutOnCallbacks) => {
			if (stdout) {
				stdoutOnCallbacks['data'](Buffer.from(stdout));
			}
			stdoutOnCallbacks['close']();
			if (stderr) {
				stderrOnCallbacks['data'](Buffer.from(stderr));
			}
			stderrOnCallbacks['close']();
			onCallbacks['exit'](0);
		});
	};

	const mockGitThrowingErrorOnce = (errorMessage?: string) => {
		mockSpyOnSpawn(spyOnSpawn, (onCallbacks, stderrOnCallbacks, stdoutOnCallbacks) => {
			stdoutOnCallbacks['close']();
			stderrOnCallbacks['data']((errorMessage || 'error message') + '\n');
			stderrOnCallbacks['close']();
			onCallbacks['exit'](1);
		});
	};

	describe('listRebaseCandidates', () => {
		it('returns parsed commits from git log base..HEAD, excluding merges', async () => {
			// Setup
			const stdout =
				'aaaaaaa\x00subject one\x1e\n' +
				'bbbbbbb\x00subject two\x1e\n';
			mockGitSuccessOnce(stdout);

			// Run
			const result = await dataSource.listRebaseCandidates('/path/to/repo', 'baseSha');

			// Assert
			expect(result.error).toBe(null);
			expect(result.candidates).toEqual([
				{ oid: 'aaaaaaa', subject: 'subject one' },
				{ oid: 'bbbbbbb', subject: 'subject two' }
			]);
			expect(spyOnSpawn).toBeCalledWith(
				'/path/to/git',
				['log', '--reverse', '--no-merges', '--format=%H%x00%s%x1e', 'baseSha..HEAD'],
				expect.objectContaining({ cwd: '/path/to/repo' })
			);
		});

		it('returns an empty list when there are no commits', async () => {
			// Setup
			mockGitSuccessOnce('');

			// Run
			const result = await dataSource.listRebaseCandidates('/path/to/repo', 'baseSha');

			// Assert
			expect(result.error).toBe(null);
			expect(result.candidates).toEqual([]);
		});

		it('returns the git error', async () => {
			// Setup
			mockGitThrowingErrorOnce('fatal: bad revision');

			// Run
			const result = await dataSource.listRebaseCandidates('/path/to/repo', 'baseSha');

			// Assert
			expect(result.error).toContain('fatal: bad revision');
			expect(result.candidates).toEqual([]);
		});
	});

	describe('rebaseContinue', () => {
		it('runs git rebase --continue with the supplied env', async () => {
			// Setup
			mockGitSuccessOnce();

			// Run
			const result = await dataSource.rebaseContinue('/path/to/repo', { GIT_SEQUENCE_EDITOR: 'foo', GIT_EDITOR: 'bar' });

			// Assert
			expect(result).toBe(null);
			expect(spyOnSpawn).toBeCalledWith(
				'/path/to/git',
				['rebase', '--continue'],
				expect.objectContaining({
					cwd: '/path/to/repo',
					env: expect.objectContaining({ GIT_SEQUENCE_EDITOR: 'foo', GIT_EDITOR: 'bar' })
				})
			);
		});

		it('returns the git error', async () => {
			// Setup
			mockGitThrowingErrorOnce('unresolved conflicts');

			// Run
			const result = await dataSource.rebaseContinue('/path/to/repo', {});

			// Assert
			expect(result).toContain('unresolved conflicts');
		});
	});

	describe('rebaseSkip', () => {
		it('runs git rebase --skip', async () => {
			// Setup
			mockGitSuccessOnce();

			// Run
			const result = await dataSource.rebaseSkip('/path/to/repo');

			// Assert
			expect(result).toBe(null);
			expect(spyOnSpawn).toBeCalledWith('/path/to/git', ['rebase', '--skip'], expect.objectContaining({ cwd: '/path/to/repo' }));
		});
	});

	describe('rebaseAbort', () => {
		it('runs git rebase --abort', async () => {
			// Setup
			mockGitSuccessOnce();

			// Run
			const result = await dataSource.rebaseAbort('/path/to/repo');

			// Assert
			expect(result).toBe(null);
			expect(spyOnSpawn).toBeCalledWith('/path/to/git', ['rebase', '--abort'], expect.objectContaining({ cwd: '/path/to/repo' }));
		});
	});

	describe('rebaseAmendContinue', () => {
		it('runs commit --amend --no-edit then rebase --continue', async () => {
			// Setup: working tree dirty (both diff --quiet probes fail) so the amend path runs.
			mockGitThrowingErrorOnce();
			mockGitThrowingErrorOnce();
			mockGitSuccessOnce();
			mockGitSuccessOnce();
			vscode.mockExtensionSettingReturnValue('repository.sign.commits', false);

			// Run
			const result = await dataSource.rebaseAmendContinue('/path/to/repo', { GIT_EDITOR: 'foo' });

			// Assert
			expect(result).toBe(null);
			expect(spyOnSpawn).toHaveBeenNthCalledWith(3, '/path/to/git', ['commit', '--amend', '--no-edit', '-a'], expect.objectContaining({ cwd: '/path/to/repo' }));
			expect(spyOnSpawn).toHaveBeenNthCalledWith(4, '/path/to/git', ['rebase', '--continue'], expect.objectContaining({
				cwd: '/path/to/repo',
				env: expect.objectContaining({ GIT_EDITOR: 'foo' })
			}));
		});

		it('signs the amended commit when signCommits is enabled', async () => {
			// Setup: working tree dirty, then amend+continue both succeed.
			mockGitThrowingErrorOnce();
			mockGitThrowingErrorOnce();
			mockGitSuccessOnce();
			mockGitSuccessOnce();
			vscode.mockExtensionSettingReturnValue('repository.sign.commits', true);

			// Run
			await dataSource.rebaseAmendContinue('/path/to/repo', {});

			// Assert
			expect(spyOnSpawn).toHaveBeenNthCalledWith(3, '/path/to/git', ['commit', '--amend', '--no-edit', '-a', '-S'], expect.objectContaining({ cwd: '/path/to/repo' }));
		});

		it('returns the amend error without continuing', async () => {
			// Setup: working tree dirty, then amend fails.
			mockGitThrowingErrorOnce();
			mockGitThrowingErrorOnce();
			mockGitThrowingErrorOnce('amend failed');
			vscode.mockExtensionSettingReturnValue('repository.sign.commits', false);

			// Run
			const result = await dataSource.rebaseAmendContinue('/path/to/repo', {});

			// Assert
			expect(result).toContain('amend failed');
			expect(spyOnSpawn).toHaveBeenCalledTimes(3);
		});

		it('skips the amend and runs rebase --continue when the working tree is clean', async () => {
			// Setup: both diff --quiet probes succeed (clean), then rebase --continue succeeds.
			mockGitSuccessOnce();
			mockGitSuccessOnce();
			mockGitSuccessOnce();
			vscode.mockExtensionSettingReturnValue('repository.sign.commits', false);

			// Run
			const result = await dataSource.rebaseAmendContinue('/path/to/repo', { GIT_EDITOR: 'foo' });

			// Assert
			expect(result).toBe(null);
			expect(spyOnSpawn).toHaveBeenCalledTimes(3);
			expect(spyOnSpawn).toHaveBeenNthCalledWith(3, '/path/to/git', ['rebase', '--continue'], expect.objectContaining({
				cwd: '/path/to/repo',
				env: expect.objectContaining({ GIT_EDITOR: 'foo' })
			}));
		});
	});

	describe('rebaseAmendRewordContinue', () => {
		it('runs commit --amend -a -F <msg> then rebase --continue', async () => {
			// Setup
			mockGitSuccessOnce();
			mockGitSuccessOnce();
			vscode.mockExtensionSettingReturnValue('repository.sign.commits', false);

			// Run
			const result = await dataSource.rebaseAmendRewordContinue('/path/to/repo', '/tmp/msg', { GIT_EDITOR: 'foo' });

			// Assert
			expect(result).toBe(null);
			expect(spyOnSpawn).toHaveBeenNthCalledWith(1, '/path/to/git', ['commit', '--amend', '-a', '-F', '/tmp/msg'], expect.objectContaining({ cwd: '/path/to/repo' }));
			expect(spyOnSpawn).toHaveBeenNthCalledWith(2, '/path/to/git', ['rebase', '--continue'], expect.objectContaining({
				cwd: '/path/to/repo',
				env: expect.objectContaining({ GIT_EDITOR: 'foo' })
			}));
		});

		it('signs the amended commit when signCommits is enabled', async () => {
			// Setup
			mockGitSuccessOnce();
			mockGitSuccessOnce();
			vscode.mockExtensionSettingReturnValue('repository.sign.commits', true);

			// Run
			await dataSource.rebaseAmendRewordContinue('/path/to/repo', '/tmp/msg', {});

			// Assert
			expect(spyOnSpawn).toHaveBeenNthCalledWith(1, '/path/to/git', ['commit', '--amend', '-a', '-F', '/tmp/msg', '-S'], expect.objectContaining({ cwd: '/path/to/repo' }));
		});

		it('returns the amend error without continuing', async () => {
			// Setup
			mockGitThrowingErrorOnce('amend failed');
			vscode.mockExtensionSettingReturnValue('repository.sign.commits', false);

			// Run
			const result = await dataSource.rebaseAmendRewordContinue('/path/to/repo', '/tmp/msg', {});

			// Assert
			expect(result).toContain('amend failed');
			expect(spyOnSpawn).toHaveBeenCalledTimes(1);
		});
	});

	describe('undoLastRebase', () => {
		it('runs git reset --hard <origHead>', async () => {
			// Setup
			mockGitSuccessOnce();

			// Run
			const result = await dataSource.undoLastRebase('/path/to/repo', 'abc123');

			// Assert
			expect(result).toBe(null);
			expect(spyOnSpawn).toBeCalledWith('/path/to/git', ['reset', '--hard', 'abc123'], expect.objectContaining({ cwd: '/path/to/repo' }));
		});
	});

	describe('startInteractiveRebase', () => {
		it('runs git rebase -i with the supplied env', async () => {
			// Setup
			mockGitSuccessOnce();
			vscode.mockExtensionSettingReturnValue('repository.sign.commits', false);

			// Run
			const result = await dataSource.startInteractiveRebase('/path/to/repo', 'baseSha', {
				GIT_SEQUENCE_EDITOR: 'editor todo',
				GIT_EDITOR: 'editor msg'
			});

			// Assert
			expect(result).toBe(null);
			expect(spyOnSpawn).toBeCalledWith(
				'/path/to/git',
				['rebase', '-i', 'baseSha'],
				expect.objectContaining({
					cwd: '/path/to/repo',
					env: expect.objectContaining({ GIT_SEQUENCE_EDITOR: 'editor todo', GIT_EDITOR: 'editor msg' })
				})
			);
		});

		it('adds -S when signCommits is enabled', async () => {
			// Setup
			mockGitSuccessOnce();
			vscode.mockExtensionSettingReturnValue('repository.sign.commits', true);

			// Run
			await dataSource.startInteractiveRebase('/path/to/repo', 'baseSha', {});

			// Assert
			expect(spyOnSpawn).toBeCalledWith('/path/to/git', ['rebase', '-i', '-S', 'baseSha'], expect.objectContaining({ cwd: '/path/to/repo' }));
		});

		it('returns the git error', async () => {
			// Setup
			mockGitThrowingErrorOnce('cannot start rebase');
			vscode.mockExtensionSettingReturnValue('repository.sign.commits', false);

			// Run
			const result = await dataSource.startInteractiveRebase('/path/to/repo', 'baseSha', {});

			// Assert
			expect(result).toContain('cannot start rebase');
		});
	});

	describe('getRebaseStatus', () => {
		const spyOnExistsSync = fs.existsSync as jest.Mock;
		const spyOnReadFileSync = fs.readFileSync as jest.Mock;

		beforeEach(() => {
			spyOnExistsSync.mockReset();
			spyOnReadFileSync.mockReset();
		});

		it('returns idle when no rebase state directory exists', async () => {
			// Setup
			spyOnExistsSync.mockReturnValue(false);

			// Run
			const result = await dataSource.getRebaseStatus('/path/to/repo');

			// Assert
			expect(result).toEqual({ state: 'idle', progress: null, conflicts: [] });
			expect(spyOnExistsSync).toHaveBeenCalledWith(path.join('/path/to/repo', '.git', 'rebase-merge'));
			expect(spyOnExistsSync).toHaveBeenCalledWith(path.join('/path/to/repo', '.git', 'rebase-apply'));
		});

		it('reports conflict state with the list of conflicted files', async () => {
			// Setup
			spyOnExistsSync.mockImplementation((p: string) => p.endsWith('rebase-merge'));
			spyOnReadFileSync.mockImplementation((p: string) => {
				if (p.endsWith('msgnum')) return '2\n';
				if (p.endsWith('end')) return '5\n';
				throw new Error('ENOENT');
			});
			mockGitSuccessOnce('UU path/one.txt\nUU path/two.txt\n M other.txt\n');

			// Run
			const result = await dataSource.getRebaseStatus('/path/to/repo');

			// Assert
			expect(result.state).toBe('conflict');
			expect(result.progress).toEqual({ done: 2, total: 5, currentOid: null });
			expect(result.conflicts).toEqual(['path/one.txt', 'path/two.txt']);
		});

		it('reports edit-stopped state when stopped-sha exists and no conflicts', async () => {
			// Setup
			spyOnExistsSync.mockImplementation((p: string) => p.endsWith('rebase-merge'));
			spyOnReadFileSync.mockImplementation((p: string) => {
				if (p.endsWith('msgnum')) return '3\n';
				if (p.endsWith('end')) return '5\n';
				if (p.endsWith('stopped-sha')) return 'deadbeef\n';
				throw new Error('ENOENT');
			});
			mockGitSuccessOnce('');

			// Run
			const result = await dataSource.getRebaseStatus('/path/to/repo');

			// Assert
			expect(result.state).toBe('edit-stopped');
			expect(result.progress).toEqual({ done: 3, total: 5, currentOid: 'deadbeef' });
			expect(result.conflicts).toEqual([]);
		});

		it('reports running state when rebase is in progress without conflicts or edit stop', async () => {
			// Setup
			spyOnExistsSync.mockImplementation((p: string) => p.endsWith('rebase-merge'));
			spyOnReadFileSync.mockImplementation((p: string) => {
				if (p.endsWith('msgnum')) return '1\n';
				if (p.endsWith('end')) return '5\n';
				throw new Error('ENOENT');
			});
			mockGitSuccessOnce('');

			// Run
			const result = await dataSource.getRebaseStatus('/path/to/repo');

			// Assert
			expect(result.state).toBe('running');
			expect(result.conflicts).toEqual([]);
		});
	});

	describe('isWorkingTreeClean', () => {
		it('returns true when both diff --quiet probes succeed', async () => {
			// Setup
			mockGitSuccessOnce();
			mockGitSuccessOnce();

			// Run
			const result = await dataSource.isWorkingTreeClean('/path/to/repo');

			// Assert
			expect(result).toBe(true);
		});

		it('returns false when the worktree has changes', async () => {
			// Setup
			mockGitThrowingErrorOnce();
			mockGitSuccessOnce();

			// Run
			const result = await dataSource.isWorkingTreeClean('/path/to/repo');

			// Assert
			expect(result).toBe(false);
		});

		it('returns false when the index has staged changes', async () => {
			// Setup
			mockGitSuccessOnce();
			mockGitThrowingErrorOnce();

			// Run
			const result = await dataSource.isWorkingTreeClean('/path/to/repo');

			// Assert
			expect(result).toBe(false);
		});

		it('defers diff probes until the git busy probe reports idle', async () => {
			// Setup: a rebase child process is alive for the first poll window
			let busy = true;
			dataSource.setGitBusyProbe(() => busy);
			mockGitSuccessOnce();
			mockGitSuccessOnce();

			// Run
			const resultPromise = dataSource.isWorkingTreeClean('/path/to/repo');
			// No git spawn should happen while busy
			await new Promise((resolve) => setTimeout(resolve, 150));
			expect(spyOnSpawn).not.toHaveBeenCalled();
			busy = false;

			// Assert
			const result = await resultPromise;
			expect(result).toBe(true);
			expect(spyOnSpawn).toHaveBeenCalled();
		});
	});

	describe('isDetachedHead', () => {
		it('returns false when symbolic-ref succeeds', async () => {
			// Setup
			mockGitSuccessOnce('refs/heads/master\n');

			// Run
			const result = await dataSource.isDetachedHead('/path/to/repo');

			// Assert
			expect(result).toBe(false);
		});

		it('returns true when symbolic-ref exits non-zero', async () => {
			// Setup
			mockGitThrowingErrorOnce();

			// Run
			const result = await dataSource.isDetachedHead('/path/to/repo');

			// Assert
			expect(result).toBe(true);
		});
	});

	describe('resolveRef', () => {
		it('returns the trimmed rev-parse output', async () => {
			// Setup
			mockGitSuccessOnce('abc123def\n');

			// Run
			const result = await dataSource.resolveRef('/path/to/repo', 'HEAD');

			// Assert
			expect(result).toBe('abc123def');
			expect(spyOnSpawn).toBeCalledWith('/path/to/git', ['rev-parse', 'HEAD'], expect.objectContaining({ cwd: '/path/to/repo' }));
		});
	});
});
