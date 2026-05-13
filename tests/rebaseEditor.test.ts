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
		expect(runMsg('/nonexistent', '/nonexistent/msg')).toBe(1);
	});
});
