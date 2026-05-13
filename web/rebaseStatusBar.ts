type RebaseControlHandler = (action: GG.RebaseControlAction) => void;

/**
 * In-progress rebase status bar. Pinned to the top of the Git Graph view; visible only
 * while a rebase is running, paused for conflicts/edit, or has just completed (to offer Undo).
 */
class RebaseStatusBar {
	private readonly host: HTMLElement;
	private root: HTMLDivElement | null = null;
	private pendingAction: boolean = false;

	constructor(host: HTMLElement) {
		this.host = host;
	}

	public update(status: GG.RebaseLiveStatus, onControl: RebaseControlHandler) {
		// A fresh status from the backend means any prior control dispatch has returned —
		// re-enable buttons before rendering.
		this.pendingAction = false;
		if (status.state === GG.RebaseLiveStateKind.Idle && !status.canUndo) {
			this.clear();
			return;
		}
		this.render(status, onControl);
	}

	public clear() {
		if (this.root !== null) {
			this.root.remove();
			this.root = null;
		}
		this.pendingAction = false;
	}

	private render(status: GG.RebaseLiveStatus, onControl: RebaseControlHandler) {
		this.clear();
		const root = document.createElement('div');
		root.className = 'rebaseStatusBar rebaseStatusBar-' + status.state;

		const summary = document.createElement('span');
		summary.className = 'rebaseStatusBarSummary';
		summary.textContent = this.summaryText(status);
		root.appendChild(summary);

		const controlButtons: HTMLButtonElement[] = [];
		this.buttonsFor(status).forEach((btn) => {
			const el = document.createElement('button');
			el.type = 'button';
			el.dataset.action = btn.action;
			el.textContent = btn.label;
			if (btn.title) el.title = btn.title;
			if (btn.disabled) el.disabled = true;
			el.addEventListener('click', () => {
				if (this.pendingAction || el.disabled) return;
				this.pendingAction = true;
				controlButtons.forEach((b) => { b.disabled = true; });
				onControl(btn.action);
			});
			root.appendChild(el);
			controlButtons.push(el);
		});

		if (status.conflicts.length > 0) {
			const ul = document.createElement('ul');
			ul.className = 'rebaseStatusBarConflicts';
			status.conflicts.forEach((file) => {
				const li = document.createElement('li');
				li.textContent = file;
				ul.appendChild(li);
			});
			root.appendChild(ul);
		}

		if (this.isDismissable(status)) {
			const close = document.createElement('button');
			close.type = 'button';
			close.className = 'rebaseStatusBarClose';
			close.title = 'Dismiss';
			close.setAttribute('aria-label', 'Dismiss');
			close.innerHTML = '&times;';
			close.addEventListener('click', () => this.clear());
			root.appendChild(close);
		}

		this.host.prepend(root);
		this.root = root;
	}

	private summaryText(status: GG.RebaseLiveStatus): string {
		const progressStr = status.progress !== null ? ' ' + status.progress.done + '/' + status.progress.total : '';
		switch (status.state) {
			case GG.RebaseLiveStateKind.Running: return 'Rebase in progress' + progressStr;
			case GG.RebaseLiveStateKind.Conflict: return 'Rebase paused' + progressStr + ' — ' + status.conflicts.length + ' conflict(s)';
			case GG.RebaseLiveStateKind.EditStopped: return 'Rebase paused' + progressStr + ' — editing commit. Modify files, then click "Amend & Continue".';
			case GG.RebaseLiveStateKind.Idle: return status.canUndo ? 'Last rebase completed. You can undo it.' : '';
			case GG.RebaseLiveStateKind.Completed: return 'Rebase completed.';
			case GG.RebaseLiveStateKind.Aborted: return 'Rebase aborted.';
			default: return '';
		}
	}

	private buttonsFor(status: GG.RebaseLiveStatus): ReadonlyArray<{ action: GG.RebaseControlAction; label: string; title?: string; disabled?: boolean }> {
		switch (status.state) {
			case GG.RebaseLiveStateKind.Conflict:
				return [
					{ action: GG.RebaseControlAction.Continue, label: 'Continue' },
					{ action: GG.RebaseControlAction.Skip, label: 'Skip' },
					{ action: GG.RebaseControlAction.Abort, label: 'Abort' }
				];
			case GG.RebaseLiveStateKind.EditStopped:
				return [
					{
						action: GG.RebaseControlAction.AmendContinue,
						label: 'Amend & Continue',
						title: 'Fold working-tree changes into this commit (skips the amend if nothing changed) and resume the rebase.'
					},
					{
						action: GG.RebaseControlAction.AmendRewordContinue,
						label: 'Amend + Reword & Continue',
						title: 'Fold working-tree changes into this commit, edit its message, then resume the rebase.'
					},
					{
						action: GG.RebaseControlAction.Continue,
						label: 'Continue',
						title: status.worktreeDirty
							? 'Disabled: unstaged working-tree changes remain. Stage them (or use "Amend & Continue") first.'
							: status.indexDirty
								? 'Commit the staged changes as a new step on top of this commit and resume the rebase.'
								: 'Leave this commit unchanged and resume the rebase.',
						disabled: status.worktreeDirty
					},
					{ action: GG.RebaseControlAction.Abort, label: 'Abort' }
				];
			case GG.RebaseLiveStateKind.Running:
				return [{ action: GG.RebaseControlAction.Abort, label: 'Abort' }];
			case GG.RebaseLiveStateKind.Idle:
				return status.canUndo ? [{ action: GG.RebaseControlAction.Undo, label: 'Undo Rebase' }] : [];
			default:
				return [];
		}
	}

	private isDismissable(status: GG.RebaseLiveStatus): boolean {
		switch (status.state) {
			case GG.RebaseLiveStateKind.Completed:
			case GG.RebaseLiveStateKind.Aborted:
				return true;
			case GG.RebaseLiveStateKind.Idle:
				return status.canUndo;
			default:
				return false;
		}
	}
}
