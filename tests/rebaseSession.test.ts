jest.mock('fs');

import * as fs from 'fs';
import * as path from 'path';
import { RebaseSession } from '../src/rebaseSession';
import { RebaseAction, RebaseControlAction, RebaseLiveStateKind, RebasePlanItem } from '../src/types';

const fsMock = fs as jest.Mocked<typeof fs>;

interface DataSourceMock {
	startInteractiveRebase: jest.Mock;
	rebaseContinue: jest.Mock;
	rebaseSkip: jest.Mock;
	rebaseAbort: jest.Mock;
	rebaseAmendContinue: jest.Mock;
	undoLastRebase: jest.Mock;
	getRebaseStatus: jest.Mock;
	getWorkingTreeDirt: jest.Mock;
	isWorkingTreeClean: jest.Mock;
	isDetachedHead: jest.Mock;
	resolveRef: jest.Mock;
}

interface StateMock {
	getRebaseSession: jest.Mock;
	setRebaseSession: jest.Mock;
	clearRebaseSession: jest.Mock;
}

interface LoggerMock {
	log: jest.Mock;
	logError: jest.Mock;
	logCmd: jest.Mock;
}

function makeMocks(): { session: RebaseSession; dataSource: DataSourceMock; state: StateMock; logger: LoggerMock } {
	const dataSource: DataSourceMock = {
		startInteractiveRebase: jest.fn().mockResolvedValue(null),
		rebaseContinue: jest.fn().mockResolvedValue(null),
		rebaseSkip: jest.fn().mockResolvedValue(null),
		rebaseAbort: jest.fn().mockResolvedValue(null),
		rebaseAmendContinue: jest.fn().mockResolvedValue(null),
		undoLastRebase: jest.fn().mockResolvedValue(null),
		getRebaseStatus: jest.fn().mockResolvedValue({ state: 'idle', progress: null, conflicts: [] }),
		getWorkingTreeDirt: jest.fn().mockResolvedValue({ worktreeDirty: false, indexDirty: false }),
		isWorkingTreeClean: jest.fn().mockResolvedValue(true),
		isDetachedHead: jest.fn().mockResolvedValue(false),
		resolveRef: jest.fn().mockResolvedValue('origHead123')
	};
	const state: StateMock = {
		getRebaseSession: jest.fn().mockReturnValue(null),
		setRebaseSession: jest.fn().mockResolvedValue(null),
		clearRebaseSession: jest.fn().mockResolvedValue(null)
	};
	const logger: LoggerMock = { log: jest.fn(), logError: jest.fn(), logCmd: jest.fn() };
	const session = new RebaseSession(dataSource as any, state as any, '/ext/path', logger as any);
	return { session, dataSource, state, logger };
}

const samplePlan: RebasePlanItem[] = [
	{ oid: 'aaa', action: RebaseAction.Pick, subject: 'first', message: null }
];

beforeEach(() => {
	fsMock.mkdtempSync.mockReturnValue('/tmp/gg-rebase-xxx' as any);
	fsMock.mkdirSync.mockReturnValue(undefined as any);
	fsMock.writeFileSync.mockReturnValue(undefined as any);
	fsMock.rmSync.mockReturnValue(undefined as any);
});

afterEach(() => {
	jest.clearAllMocks();
});

describe('RebaseSession.start', () => {
	it('rejects when the plan is empty', async () => {
		const { session, dataSource } = makeMocks();
		const result = await session.start('/repo', 'base', []);
		expect(result.error).toMatch(/empty/i);
		expect(dataSource.startInteractiveRebase).not.toHaveBeenCalled();
	});

	it('rejects when the working tree is dirty', async () => {
		const { session, dataSource } = makeMocks();
		dataSource.isWorkingTreeClean.mockResolvedValue(false);
		const result = await session.start('/repo', 'base', samplePlan);
		expect(result.error).toMatch(/working tree/i);
		expect(dataSource.startInteractiveRebase).not.toHaveBeenCalled();
	});

	it('rejects when HEAD is detached', async () => {
		const { session, dataSource } = makeMocks();
		dataSource.isDetachedHead.mockResolvedValue(true);
		const result = await session.start('/repo', 'base', samplePlan);
		expect(result.error).toMatch(/detached/i);
		expect(dataSource.startInteractiveRebase).not.toHaveBeenCalled();
	});

	it('rejects when a rebase is already in progress', async () => {
		const { session, dataSource } = makeMocks();
		dataSource.getRebaseStatus.mockResolvedValueOnce({ state: 'conflict', progress: null, conflicts: [] });
		const result = await session.start('/repo', 'base', samplePlan);
		expect(result.error).toMatch(/already in progress/i);
		expect(dataSource.startInteractiveRebase).not.toHaveBeenCalled();
	});

	it('persists session and reports completed on the happy path', async () => {
		const { session, dataSource, state } = makeMocks();
		dataSource.getRebaseStatus
			.mockResolvedValueOnce({ state: 'idle', progress: null, conflicts: [] })
			.mockResolvedValueOnce({ state: 'idle', progress: null, conflicts: [] });

		const result = await session.start('/repo', 'base', samplePlan);

		expect(result.error).toBe(null);
		expect(result.status.state).toBe(RebaseLiveStateKind.Completed);
		expect(result.status.canUndo).toBe(true);
		expect(state.setRebaseSession).toHaveBeenCalledWith('/repo', expect.objectContaining({
			repo: '/repo', base: 'base', origHead: 'origHead123'
		}));
		expect(state.clearRebaseSession).toHaveBeenCalledWith('/repo');
		expect(dataSource.startInteractiveRebase).toHaveBeenCalledWith(
			'/repo',
			'base',
			expect.objectContaining({ GIT_SEQUENCE_EDITOR: expect.any(String), GIT_EDITOR: expect.any(String) })
		);
	});

	it('reports conflict state when git pauses on a merge conflict', async () => {
		const { session, dataSource, state } = makeMocks();
		dataSource.getRebaseStatus
			.mockResolvedValueOnce({ state: 'idle', progress: null, conflicts: [] })
			.mockResolvedValueOnce({ state: 'conflict', progress: { done: 1, total: 3, currentOid: 'aaa' }, conflicts: ['x.txt'] });
		dataSource.startInteractiveRebase.mockResolvedValue('conflict error');

		const result = await session.start('/repo', 'base', samplePlan);

		expect(result.status.state).toBe(RebaseLiveStateKind.Conflict);
		expect(result.status.conflicts).toEqual(['x.txt']);
		expect(state.clearRebaseSession).not.toHaveBeenCalled();
	});
});

describe('RebaseSession.control', () => {
	const persistedSession = {
		repo: '/repo', base: 'base', origHead: 'origHead123', plan: samplePlan,
		tmpDir: '/tmp/gg-rebase-xxx', startedAt: 1
	};

	it('errors when there is no tracked session', async () => {
		const { session } = makeMocks();
		const result = await session.control('/repo', RebaseControlAction.Continue);
		expect(result.error).toMatch(/no tracked rebase/i);
	});

	it('continues and reports completed when git finishes', async () => {
		const { session, dataSource, state } = makeMocks();
		state.getRebaseSession.mockReturnValue(persistedSession);
		dataSource.getRebaseStatus.mockResolvedValue({ state: 'idle', progress: null, conflicts: [] });

		const result = await session.control('/repo', RebaseControlAction.Continue);

		expect(result.error).toBe(null);
		expect(result.status.state).toBe(RebaseLiveStateKind.Completed);
		expect(dataSource.rebaseContinue).toHaveBeenCalledWith('/repo', expect.any(Object));
		expect(state.clearRebaseSession).toHaveBeenCalledWith('/repo');
	});

	it('amend-continues using the same env', async () => {
		const { session, dataSource, state } = makeMocks();
		state.getRebaseSession.mockReturnValue(persistedSession);
		dataSource.getRebaseStatus.mockResolvedValue({ state: 'idle', progress: null, conflicts: [] });

		await session.control('/repo', RebaseControlAction.AmendContinue);

		expect(dataSource.rebaseAmendContinue).toHaveBeenCalledWith('/repo', expect.any(Object));
	});

	it('aborts and clears the session', async () => {
		const { session, dataSource, state } = makeMocks();
		state.getRebaseSession.mockReturnValue(persistedSession);

		const result = await session.control('/repo', RebaseControlAction.Abort);

		expect(dataSource.rebaseAbort).toHaveBeenCalledWith('/repo');
		expect(state.clearRebaseSession).toHaveBeenCalledWith('/repo');
		expect(result.status.state).toBe(RebaseLiveStateKind.Idle);
		expect(result.status.canUndo).toBe(false);
	});

	it('undoes via reset --hard origHead and clears the session', async () => {
		const { session, dataSource, state } = makeMocks();
		state.getRebaseSession.mockReturnValue(persistedSession);

		await session.control('/repo', RebaseControlAction.Undo);

		expect(dataSource.undoLastRebase).toHaveBeenCalledWith('/repo', 'origHead123');
		expect(state.clearRebaseSession).toHaveBeenCalledWith('/repo');
	});
});

describe('RebaseSession.query', () => {
	it('returns idle with canUndo when a session exists but git reports no rebase', async () => {
		const { session, dataSource, state } = makeMocks();
		state.getRebaseSession.mockReturnValue({
			repo: '/repo', base: 'b', origHead: 'origHead123', plan: [], tmpDir: '/t', startedAt: 0
		});
		dataSource.getRebaseStatus.mockResolvedValue({ state: 'idle', progress: null, conflicts: [] });

		const result = await session.query('/repo');

		expect(result.state).toBe(RebaseLiveStateKind.Idle);
		expect(result.origHead).toBe('origHead123');
		expect(result.canUndo).toBe(true);
		expect(state.clearRebaseSession).toHaveBeenCalledWith('/repo');
	});

	it('returns idle without canUndo when there is no session and no rebase', async () => {
		const { session, dataSource } = makeMocks();
		dataSource.getRebaseStatus.mockResolvedValue({ state: 'idle', progress: null, conflicts: [] });

		const result = await session.query('/repo');

		expect(result.state).toBe(RebaseLiveStateKind.Idle);
		expect(result.canUndo).toBe(false);
	});

	it('reflects an in-progress rebase reported by git', async () => {
		const { session, dataSource, state } = makeMocks();
		state.getRebaseSession.mockReturnValue({
			repo: '/repo', base: 'b', origHead: 'origHead123', plan: [], tmpDir: '/t', startedAt: 0
		});
		dataSource.getRebaseStatus.mockResolvedValue({
			state: 'conflict', progress: { done: 2, total: 5, currentOid: 'x' }, conflicts: ['a.txt']
		});

		const result = await session.query('/repo');

		expect(result.state).toBe(RebaseLiveStateKind.Conflict);
		expect(result.conflicts).toEqual(['a.txt']);
	});

	it('re-arms the prompt watcher for a live rebase whose watcher was lost to a host restart', async () => {
		const { session, dataSource, state } = makeMocks();
		state.getRebaseSession.mockReturnValue({
			repo: '/repo', base: 'b', origHead: 'origHead123', plan: [], tmpDir: '/t', startedAt: 0
		});
		dataSource.getRebaseStatus.mockResolvedValue({
			state: 'conflict', progress: { done: 2, total: 5, currentOid: 'x' }, conflicts: ['a.txt']
		});

		await session.query('/repo');

		expect(fsMock.watch).toHaveBeenCalledWith(path.join('/t', 'prompt'), expect.anything(), expect.any(Function));
	});

	it('cleans up the session tmpDir when git reports no rebase', async () => {
		const { session, dataSource, state } = makeMocks();
		state.getRebaseSession.mockReturnValue({
			repo: '/repo', base: 'b', origHead: 'origHead123', plan: [], tmpDir: '/t', startedAt: 0
		});
		dataSource.getRebaseStatus.mockResolvedValue({ state: 'idle', progress: null, conflicts: [] });

		await session.query('/repo');

		expect(fsMock.rmSync).toHaveBeenCalledWith('/t', { recursive: true, force: true });
	});
});

describe('RebaseSession.isGitBusy', () => {
	it('is true only while a rebase child process is running', async () => {
		const { session, dataSource, state } = makeMocks();
		state.getRebaseSession.mockReturnValue({
			repo: '/repo', base: 'b', origHead: 'origHead123', plan: samplePlan, tmpDir: '/t', startedAt: 0
		});
		dataSource.getRebaseStatus.mockResolvedValue({ state: 'idle', progress: null, conflicts: [] });

		let busyDuringRun: boolean[] = [];
		dataSource.rebaseContinue.mockImplementation(async () => {
			busyDuringRun.push(session.isGitBusy());
			return null;
		});

		expect(session.isGitBusy()).toBe(false);
		await session.control('/repo', RebaseControlAction.Continue);
		expect(session.isGitBusy()).toBe(false);
		expect(busyDuringRun).toEqual([true]);
	});

	it('reports busy across overlapping control windows', async () => {
		const { session, dataSource, state } = makeMocks();
		state.getRebaseSession.mockReturnValue({
			repo: '/repo', base: 'b', origHead: 'origHead123', plan: samplePlan, tmpDir: '/t', startedAt: 0
		});
		dataSource.getRebaseStatus.mockResolvedValue({ state: 'idle', progress: null, conflicts: [] });

		let busyDuringInner: boolean | null = null;
		dataSource.rebaseContinue.mockImplementation(async () => {
			// Simulate an overlapping read window (e.g. a status probe that started
			// before busy was set) checking the flag mid-flight.
			busyDuringInner = session.isGitBusy();
			return null;
		});

		await session.control('/repo', RebaseControlAction.Continue);
		expect(busyDuringInner).toBe(true);
	});

	it('logs the busy window boundaries and git errors for control actions', async () => {
		const { session, dataSource, state, logger } = makeMocks();
		state.getRebaseSession.mockReturnValue({
			repo: '/repo', base: 'b', origHead: 'origHead123', plan: samplePlan, tmpDir: '/t', startedAt: 0
		});
		dataSource.getRebaseStatus.mockResolvedValue({ state: 'idle', progress: null, conflicts: [] });
		dataSource.rebaseContinue.mockResolvedValue('fatal: demo git failure');

		await session.control('/repo', RebaseControlAction.Continue);

		const messages = logger.log.mock.calls.map((call: unknown[]) => String(call[0]));
		expect(messages).toContainEqual(expect.stringContaining('[rebase] git busy window: enter'));
		expect(messages).toContainEqual(expect.stringContaining('[rebase] git busy window: exit'));
		const errorMessages = logger.logError.mock.calls.map((call: unknown[]) => String(call[0]));
		expect(errorMessages).toContainEqual(expect.stringContaining('[rebase] control continue: git failed'));
		expect(errorMessages).toContainEqual(expect.stringContaining('fatal: demo git failure'));
	});
});
