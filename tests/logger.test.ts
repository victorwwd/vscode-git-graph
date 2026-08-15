import * as date from './mocks/date';
import * as vscode from './mocks/vscode';
jest.mock('vscode', () => vscode, { virtual: true });

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { Logger } from '../src/logger';

const outputChannel = vscode.mocks.outputChannel;

describe('Logger', () => {
	let logger: Logger;
	beforeEach(() => {
		logger = new Logger();
	});
	afterEach(() => {
		logger.dispose();
	});

	it('Should create and dispose an output channel', () => {
		// Run
		logger.dispose();

		// Assert
		expect(vscode.window.createOutputChannel).toHaveBeenCalledWith('Git Graph');
		expect(outputChannel.dispose).toBeCalledTimes(1);
	});

	it('Should log a message to the Output Channel', () => {
		// Run
		logger.log('Test');

		// Assert
		expect(outputChannel.appendLine).toHaveBeenCalledWith('[2020-04-22 12:40:58.000] Test');
	});

	describe('Should log a command to the Output Channel', () => {
		it('Standard arguments are unchanged', () => {
			// Run
			logger.logCmd('git', ['cmd', '-f', '--arg1']);

			// Assert
			expect(outputChannel.appendLine).toHaveBeenCalledWith('[2020-04-22 12:40:58.000] > git cmd -f --arg1');
		});

		it('Format arguments are abbreviated', () => {
			// Run
			logger.logCmd('git', ['cmd', '--format="format-string"']);

			// Assert
			expect(outputChannel.appendLine).toHaveBeenCalledWith('[2020-04-22 12:40:58.000] > git cmd --format=...');
		});

		it('Arguments with spaces are surrounded with double quotes', () => {
			// Run
			logger.logCmd('git', ['cmd', 'argument with spaces']);

			// Assert
			expect(outputChannel.appendLine).toHaveBeenCalledWith('[2020-04-22 12:40:58.000] > git cmd "argument with spaces"');
		});

		it('Arguments with spaces are surrounded with double quotes, and any internal double quotes are escaped', () => {
			// Run
			logger.logCmd('git', ['cmd', 'argument with "double quotes" and spaces']);

			// Assert
			expect(outputChannel.appendLine).toHaveBeenCalledWith('[2020-04-22 12:40:58.000] > git cmd "argument with \\"double quotes\\" and spaces"');
		});

		it('Empty string arguments are shown as two double quotes', () => {
			// Run
			logger.logCmd('git', ['cmd', '']);

			// Assert
			expect(outputChannel.appendLine).toHaveBeenCalledWith('[2020-04-22 12:40:58.000] > git cmd ""');
		});

		it('Should transform all arguments of a command, when logging it to the Output Channel', () => {
			// Setup
			date.setCurrentTime(1587559258.1);

			// Run
			logger.logCmd('git', ['cmd', '--arg1', '--format="format-string"', '', 'argument with spaces', 'argument with "double quotes" and spaces']);

			// Assert
			expect(outputChannel.appendLine).toHaveBeenCalledWith('[2020-04-22 12:40:58.100] > git cmd --arg1 --format=... "" "argument with spaces" "argument with \\"double quotes\\" and spaces"');
		});
	});

	it('Should log an error to the Output Channel', () => {
		// Setup
		date.setCurrentTime(1587559258.01);

		// Run
		logger.logError('Test');

		// Assert
		expect(outputChannel.appendLine).toHaveBeenCalledWith('[2020-04-22 12:40:58.010] ERROR: Test');
	});

	describe('File sink', () => {
		const logPath = path.join(os.tmpdir(), 'git-graph-2020-04-22.log');

		afterEach(() => {
			delete process.env.GIT_GRAPH_FILE_LOG;
			try { fs.unlinkSync(logPath); } catch (_) { /* already gone */ }
		});

		it('Should mirror log and error lines to the daily file in the temp directory', () => {
			// Setup: the global setup disables the sink; opt back in for this test
			process.env.GIT_GRAPH_FILE_LOG = '1';
			const fileLogger = new Logger();

			// Run
			fileLogger.log('FileSinkTest');
			fileLogger.logError('FileSinkError');
			fileLogger.dispose();

			// Assert
			const contents = fs.readFileSync(logPath, 'utf8');
			expect(contents).toContain('[2020-04-22 12:40:58.000] FileSinkTest');
			expect(contents).toContain('ERROR: FileSinkError');
		});
	});
});
