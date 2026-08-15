import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runMsg, runTodo } from '../src/rebaseEditor/main';

function makeTmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-editor-test-'));
}

describe('rebaseEditor.runTodo', () => {
	it('rewrites the git todo file using the supplied plan', () => {
		const dir = makeTmpDir();
		const planPath = path.join(dir, 'plan.json');
		const todoPath = path.join(dir, 'todo');
		fs.writeFileSync(planPath, JSON.stringify({
			items: [
				{ oid: 'aaaaaaa', action: 'pick', subject: 'first' },
				{ oid: 'bbbbbbb', action: 'squash', subject: 'second' },
				{ oid: 'ccccccc', action: 'drop', subject: 'third' }
			]
		}));
		fs.writeFileSync(todoPath,
			'pick aaaaaaa first\n' +
			'pick bbbbbbb second\n' +
			'pick ccccccc third\n'
		);

		const code = runTodo(planPath, todoPath);
		expect(code).toBe(0);

		const result = fs.readFileSync(todoPath, 'utf8');
		expect(result).toBe(
			'pick aaaaaaa first\n' +
			'squash bbbbbbb second\n' +
			'drop ccccccc third\n'
		);
	});

	it('reorders the todo entries to match the plan order', () => {
		const dir = makeTmpDir();
		const planPath = path.join(dir, 'plan.json');
		const todoPath = path.join(dir, 'todo');
		fs.writeFileSync(planPath, JSON.stringify({
			items: [
				{ oid: 'ccccccc', action: 'pick', subject: 'third' },
				{ oid: 'aaaaaaa', action: 'pick', subject: 'first' },
				{ oid: 'bbbbbbb', action: 'pick', subject: 'second' }
			]
		}));
		fs.writeFileSync(todoPath, 'placeholder\n');

		expect(runTodo(planPath, todoPath)).toBe(0);
		expect(fs.readFileSync(todoPath, 'utf8')).toBe(
			'pick ccccccc third\n' +
			'pick aaaaaaa first\n' +
			'pick bbbbbbb second\n'
		);
	});

	it('returns 1 when the plan file is missing', () => {
		expect(runTodo('/nonexistent/plan-not-here.json', '/tmp/whatever')).toBe(1);
	});
});

describe('rebaseEditor.runMsg', () => {
	it('returns 1 when the commit message file cannot be read', () => {
		const realNow = Date.now();
		jest.spyOn(Date, 'now')
			.mockReturnValueOnce(realNow)
			.mockReturnValue(realNow + 600_001);
		expect(runMsg('/nonexistent', '/nonexistent/msg')).toBe(1);
		jest.restoreAllMocks();
	});

	// runMsg blocks its thread polling for the response (Atomics.wait), so the
	// host side must be simulated by a separate process that answers the prompt
	// once the request/waiting files appear.
	const answerPromptFromHelper = (promptDir: string, response: string) => {
		const script =
			'const fs = require("fs");' +
			'const waitFor = ' + JSON.stringify(path.join(promptDir, 'waiting')) + ';' +
			'const responsePath = ' + JSON.stringify(path.join(promptDir, 'response.txt')) + ';' +
			'const payload = ' + JSON.stringify(response) + ';' +
			'const tick = () => { if (fs.existsSync(waitFor)) { fs.writeFileSync(responsePath, payload); } else { setTimeout(tick, 10); } };' +
			'tick();';
		return cp.spawn(process.execPath, ['-e', script]);
	};

	it('writes the message and returns 0 when the prompt response is accepted', () => {
		const dir = makeTmpDir();
		fs.mkdirSync(path.join(dir, 'prompt'));
		const msgPath = path.join(dir, 'COMMIT_EDITMSG');
		fs.writeFileSync(msgPath, 'original message\n');
		const helper = answerPromptFromHelper(path.join(dir, 'prompt'), JSON.stringify({ accepted: true, message: 'edited message' }));

		try {
			expect(runMsg(path.join(dir, 'msg'), msgPath)).toBe(0);
		} finally {
			helper.kill();
		}
		expect(fs.readFileSync(msgPath, 'utf8')).toBe('edited message');
	});

	it('writes the default message and returns 0 when the prompt response is cancelled', () => {
		const dir = makeTmpDir();
		fs.mkdirSync(path.join(dir, 'prompt'));
		const msgPath = path.join(dir, 'COMMIT_EDITMSG');
		fs.writeFileSync(msgPath, 'original message\n');
		const helper = answerPromptFromHelper(path.join(dir, 'prompt'), JSON.stringify({ accepted: false, message: 'original message\n' }));

		try {
			expect(runMsg(path.join(dir, 'msg'), msgPath)).toBe(0);
		} finally {
			helper.kill();
		}
		expect(fs.readFileSync(msgPath, 'utf8')).toBe('original message\n');
	});
});
