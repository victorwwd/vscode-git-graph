import * as fs from 'fs';
import * as path from 'path';
import { RebasePlanItem } from '../types';

interface PlanFile {
	items: RebasePlanItem[];
}

const POLL_INTERVAL_MS = 200;
const TIMEOUT_MS = 600000;

export function runTodo(planPath: string, todoPath: string): number {
	let plan: PlanFile;
	try {
		plan = JSON.parse(fs.readFileSync(planPath, 'utf8')) as PlanFile;
	} catch (err) {
		process.stderr.write('rebaseEditor: failed to read plan: ' + (err as Error).message + '\n');
		return 1;
	}

	const lines = plan.items.map((item) => item.action + ' ' + item.oid + ' ' + item.subject);
	try {
		fs.writeFileSync(todoPath, lines.join('\n') + '\n');
	} catch (err) {
		process.stderr.write('rebaseEditor: failed to write todo: ' + (err as Error).message + '\n');
		return 1;
	}
	return 0;
}

export function runMsg(msgDir: string, msgPath: string): number {
	return runPrompt(msgDir, msgPath);
}

function runPrompt(msgDir: string, msgPath: string): number {
	const promptDir = path.join(msgDir, '..', 'prompt');
	const requestPath = path.join(promptDir, 'request.txt');
	const waitingPath = path.join(promptDir, 'waiting');
	const responsePath = path.join(promptDir, 'response.txt');

	try {
		fs.mkdirSync(promptDir, { recursive: true });
		try { fs.unlinkSync(responsePath); } catch (_) { /* not present */ }
		fs.writeFileSync(requestPath, msgPath);
		fs.writeFileSync(waitingPath, '');
	} catch (err) {
		process.stderr.write('rebaseEditor: failed to write prompt request: ' + (err as Error).message + '\n');
		return 1;
	}

	const sab = new SharedArrayBuffer(4);
	const i32 = new Int32Array(sab);
	const deadline = Date.now() + TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (fs.existsSync(responsePath)) {
			let response: string;
			try {
				response = fs.readFileSync(responsePath, 'utf8');
			} catch (err) {
				process.stderr.write('rebaseEditor: failed to read prompt response: ' + (err as Error).message + '\n');
				return 1;
			}
			try {
				fs.writeFileSync(msgPath, response);
			} catch (err) {
				process.stderr.write('rebaseEditor: failed to write commit message: ' + (err as Error).message + '\n');
				return 1;
			}
			try { fs.unlinkSync(responsePath); } catch (_) { /* best-effort cleanup */ }
			try { fs.unlinkSync(requestPath); } catch (_) { /* best-effort cleanup */ }
			try { fs.unlinkSync(waitingPath); } catch (_) { /* host may already have consumed */ }
			return 0;
		}
		Atomics.wait(i32, 0, 0, POLL_INTERVAL_MS);
	}
	process.stderr.write('rebaseEditor: timed out waiting for message response\n');
	return 1;
}

export function main(argv: string[]): number {
	const sub = argv[2];
	const rest = argv.slice(3);
	if (sub === 'todo' && rest.length === 2) return runTodo(rest[0], rest[1]);
	if (sub === 'msg' && rest.length === 2) return runMsg(rest[0], rest[1]);
	process.stderr.write('rebaseEditor: usage: main.js (todo <plan> <todoFile>|msg <msgDir> <msgFile>)\n');
	return 2;
}

if (require.main === module) {
	process.exit(main(process.argv));
}
