import { BufferedQueue } from '../src/utils/bufferedQueue';

describe('BufferedQueue', () => {
	describe('basic functionality', () => {
		it('Should add items to the queue, and then process them once the buffer has expired', async () => {
			// Setup
			const onItem = jest.fn(() => Promise.resolve(true)), onChanges = jest.fn(() => { });
			const queue = new BufferedQueue<string>(onItem, onChanges, 50);

			// Run
			queue.enqueue('a');
			queue.enqueue('b');
			queue.enqueue('c');

			// Assert - wait for buffer to process
			await new Promise(resolve => setTimeout(resolve, 100));

			// Assert
			expect(queue['queue']).toStrictEqual([]);
			expect(queue['processing']).toBe(false);
			expect(onItem).toHaveBeenCalledTimes(3);
			expect(onItem).toHaveBeenCalledWith('a');
			expect(onItem).toHaveBeenCalledWith('b');
			expect(onItem).toHaveBeenCalledWith('c');
			expect(onChanges).toHaveBeenCalledTimes(1);

			// Cleanup
			queue.dispose();
		});

		it('Shouldn\'t add duplicate items to the queue', async () => {
			// Setup
			const onItem = jest.fn(() => Promise.resolve(true)), onChanges = jest.fn(() => { });
			const queue = new BufferedQueue<string>(onItem, onChanges, 50);

			// Run
			queue.enqueue('a');
			queue.enqueue('b');
			queue.enqueue('c');
			queue.enqueue('a');

			// Assert - wait for buffer to process
			await new Promise(resolve => setTimeout(resolve, 100));

			// Assert
			expect(onItem).toHaveBeenCalledTimes(3);
			expect(onItem).toHaveBeenCalledWith('b');
			expect(onItem).toHaveBeenCalledWith('c');
			expect(onItem).toHaveBeenCalledWith('a');
			expect(onChanges).toHaveBeenCalledTimes(1);
		});

		it('Shouldn\'t call onChanges if no items resulted in a change', async () => {
			// Setup
			const onItem = jest.fn(() => Promise.resolve(false)), onChanges = jest.fn(() => { });
			const queue = new BufferedQueue<string>(onItem, onChanges, 50);

			// Run
			queue.enqueue('a');
			queue.enqueue('b');
			queue.enqueue('c');

			// Assert - wait for buffer to process
			await new Promise(resolve => setTimeout(resolve, 100));

			// Assert
			expect(onItem).toHaveBeenCalledTimes(3);
			expect(onItem).toHaveBeenCalledWith('a');
			expect(onItem).toHaveBeenCalledWith('b');
			expect(onItem).toHaveBeenCalledWith('c');
			expect(onChanges).toHaveBeenCalledTimes(0);
		});

		it('Should clear the timeout when disposed', async () => {
			// Setup
			const onItem = jest.fn(() => Promise.resolve(true)), onChanges = jest.fn(() => { });
			const queue = new BufferedQueue<string>(onItem, onChanges, 50);

			// Run
			queue.enqueue('a');
			queue.enqueue('b');
			queue.enqueue('c');

			// Assert
			expect(queue['queue']).toStrictEqual(['a', 'b', 'c']);

			// Run
			queue.dispose();

			// Assert - wait to confirm nothing processes after dispose
			await new Promise(resolve => setTimeout(resolve, 100));
			expect(onItem).not.toHaveBeenCalled();
		});
	});

	describe('bufferDuration', () => {
		it('Should use the default buffer duration of 1000ms', async () => {
			// Setup
			const onItem = jest.fn(() => Promise.resolve(true)), onChanges = jest.fn(() => { });
			const queue = new BufferedQueue<string>(onItem, onChanges);

			// Run
			queue.enqueue('a');

			// Wait less than default buffer - should not have processed yet
			await new Promise(resolve => setTimeout(resolve, 50));
			expect(onItem).not.toHaveBeenCalled();

			// Wait for default buffer to elapse
			await new Promise(resolve => setTimeout(resolve, 1000));
			expect(onItem).toHaveBeenCalledWith('a');
			expect(onChanges).toHaveBeenCalledTimes(1);
		});
	});

	describe('processing state', () => {
		it('Shouldn\'t trigger a new timeout if the queue is already processing events', () => {
			// Setup
			const onItem = jest.fn(() => Promise.resolve(true)), onChanges = jest.fn(() => { });
			const queue = new BufferedQueue<string>(onItem, onChanges);
			queue['processing'] = true;

			// Run
			queue.enqueue('a');
			queue.enqueue('b');
			queue.enqueue('c');

			// Assert
			expect(queue['queue']).toStrictEqual(['a', 'b', 'c']);
			expect(queue['timeout']).toBe(null);

			queue.dispose();
		});
	});
});
