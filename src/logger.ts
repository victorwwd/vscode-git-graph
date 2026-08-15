import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Disposable } from './utils/disposable';

const DOUBLE_QUOTE_REGEXP = /"/g;

/** Maximum bytes written to a day's log file before the file sink stops appending. */
const FILE_LOG_MAX_BYTES = 50 * 1024 * 1024;
/** Prefix of the rolling file logs, kept for the current day only. */
const FILE_LOG_PREFIX = 'git-graph-';
/** Set to disable the file sink (tests run suites in parallel workers that would
 * race on the shared temp-dir file; the sink itself is covered by logger.test.ts). */
const FILE_LOG_DISABLED_ENV = 'GIT_GRAPH_FILE_LOG';

/**
 * Manages the Git Graph Logger, which writes log information to the Git Graph
 * Output Channel and, for diagnosability across extension host restarts, to a
 * daily file in the system temp directory. Only the current day's file is kept;
 * older ones are deleted on activation, and writing stops once a file reaches
 * {@link FILE_LOG_MAX_BYTES}. Any file error disables the sink silently —
 * logging must never affect functionality.
 */
export class Logger extends Disposable {
	private readonly channel: vscode.OutputChannel;
	private fileStream: fs.WriteStream | null = null;
	private fileLogDate: string = '';
	private fileLogBytes: number = 0;
	private fileLogDisabled: boolean = false;

	/**
	 * Creates the Git Graph Logger.
	 */
	constructor() {
		super();
		this.channel = vscode.window.createOutputChannel('Git Graph');
		this.registerDisposable(this.channel);
		this.openFileLog();
		this.registerDisposable({ dispose: () => this.closeFileLog() });
	}

	/**
	 * Log a message to the Output Channel (and the daily file sink).
	 * @param message The string to be logged.
	 */
	public log(message: string) {
		const date = new Date();
		const timestamp = date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds()) + '.' + pad3(date.getMilliseconds());
		this.channel.appendLine('[' + timestamp + '] ' + message);
		this.writeToFileLog(timestamp, message);
	}

	/**
	 * Log the execution of a spawned command to the Output Channel.
	 * @param cmd The command being spawned.
	 * @param args The arguments passed to the command.
	 */
	public logCmd(cmd: string, args: string[]) {
		this.log('> ' + cmd + ' ' + args.map((arg) => arg === ''
			? '""'
			: arg.startsWith('--format=')
				? '--format=...'
				: arg.includes(' ')
					? '"' + arg.replace(DOUBLE_QUOTE_REGEXP, '\\"') + '"'
					: arg
		).join(' '));
	}

	/**
	 * Log an error message to the Output Channel.
	 * @param message The string to be logged.
	 */
	public logError(message: string) {
		this.log('ERROR: ' + message);
	}

	/**
	 * Open (or roll over to) today's log file and delete stale days. Failures
	 * disable the file sink for the session.
	 */
	private openFileLog(): void {
		if (process.env[FILE_LOG_DISABLED_ENV] === '0') {
			this.fileLogDisabled = true;
			return;
		}
		try {
			const today = fileLogDay(new Date());
			this.deleteStaleFileLogs(today);
			this.fileLogDate = today;
			this.fileLogBytes = fs.existsSync(this.fileLogPath(today)) ? fs.statSync(this.fileLogPath(today)).size : 0;
			this.fileStream = fs.createWriteStream(this.fileLogPath(today), { flags: 'a' });
			this.fileStream.on('error', () => { this.fileLogDisabled = true; });
		} catch (_) {
			this.fileLogDisabled = true;
		}
	}

	/**
	 * Append a line to the daily file, rolling over at midnight and stopping at
	 * the size cap. Best-effort: any error permanently disables the sink.
	 */
	private writeToFileLog(timestamp: string, message: string): void {
		if (this.fileLogDisabled) return;
		const today = fileLogDay(new Date());
		if (today !== this.fileLogDate) {
			this.closeFileLog();
			this.openFileLog();
			if (this.fileLogDisabled) return;
		}
		if (this.fileLogBytes > FILE_LOG_MAX_BYTES) return;
		try {
			const line = '[' + timestamp + '] ' + message + '\n';
			this.fileLogBytes += Buffer.byteLength(line);
			this.fileStream!.write(line);
		} catch (_) {
			this.fileLogDisabled = true;
		}
	}

	/**
	 * End the current file stream, if open.
	 */
	private closeFileLog(): void {
		if (this.fileStream !== null) {
			try { this.fileStream.end(); } catch (_) { /* best-effort */ }
			this.fileStream = null;
		}
	}

	/**
	 * The absolute path of a day's log file in the system temp directory.
	 */
	private fileLogPath(day: string): string {
		return path.join(os.tmpdir(), FILE_LOG_PREFIX + day + '.log');
	}

	/**
	 * Delete log files from previous days so only the current day is retained.
	 */
	private deleteStaleFileLogs(today: string): void {
		try {
			for (const name of fs.readdirSync(os.tmpdir())) {
				if (name.startsWith(FILE_LOG_PREFIX) && name.endsWith('.log') && name !== FILE_LOG_PREFIX + today + '.log') {
					try { fs.unlinkSync(path.join(os.tmpdir(), name)); } catch (_) { /* locked; try again next day */ }
				}
			}
		} catch (_) { /* temp dir unreadable; skip cleanup */ }
	}
}

/**
 * Format a date as the YYYY-MM-DD used in log file names.
 */
function fileLogDay(date: Date): string {
	return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
}

/**
 * Pad a number with a leading zero if it is less than two digits long.
 * @param n The number to be padded.
 * @returns The padded number.
 */
function pad2(n: number): string {
	return (n > 9 ? '' : '0') + n;
}

/**
 * Pad a number with leading zeros if it is less than three digits long.
 * @param n The number to be padded.
 * @returns The padded number.
 */
function pad3(n: number): string {
	return (n > 99 ? '' : n > 9 ? '0' : '00') + n;
}
