interface RebasePanelCallbacks {
	readonly onApply: (plan: ReadonlyArray<GG.RebasePlanItem>) => void;
	readonly onCancel: () => void;
}

const REBASE_PANEL_ACTIONS: ReadonlyArray<GG.RebaseAction> = [
	GG.RebaseAction.Pick,
	GG.RebaseAction.Reword,
	GG.RebaseAction.Edit,
	GG.RebaseAction.Squash,
	GG.RebaseAction.Fixup,
	GG.RebaseAction.Drop
];

/**
 * Standalone editing panel for an interactive rebase. Lifetime is one rebase plan:
 * opened from the commit context menu, closed on Apply or Cancel.
 *
 * Message editing (reword / squash) is handled during the rebase via interactive
 * prompts on the status bar, not in this panel — matching GitLens-style behaviour.
 */
class RebasePanel {
	private root: HTMLDivElement | null = null;
	private plan: GG.RebasePlanItem[] = [];
	private callbacks: RebasePanelCallbacks | null = null;

	public open(candidates: ReadonlyArray<GG.RebaseCandidate>, callbacks: RebasePanelCallbacks) {
		// Backend returns candidates in git's natural rebase order (oldest first).
		// Display newest-first to match the graph view; reverse again on Apply.
		const reversed = candidates.slice().reverse();
		this.plan = reversed.map((c) => ({
			oid: c.oid,
			action: GG.RebaseAction.Pick,
			subject: c.subject,
			message: null
		}));
		this.callbacks = callbacks;
		this.render();
	}

	public close() {
		if (this.root !== null) {
			this.root.remove();
			this.root = null;
		}
		this.callbacks = null;
		this.plan = [];
	}

	public isOpen(): boolean {
		return this.root !== null;
	}

	private render() {
		this.removeRoot();
		const root = document.createElement('div');
		root.className = 'rebasePanel';
		root.innerHTML =
			'<header>' +
				'<strong>Interactive Rebase</strong>' +
				'<button class="rebasePanelCancel" type="button">Cancel</button>' +
			'</header>' +
			'<ul class="rebasePanelList"></ul>' +
			'<footer>' +
				'<button class="rebasePanelApply" type="button">Apply</button>' +
			'</footer>';
		document.body.appendChild(root);
		this.root = root;

		const list = root.querySelector('.rebasePanelList') as HTMLUListElement;
		this.plan.forEach((item, index) => list.appendChild(this.renderItem(item, index)));

		(root.querySelector('.rebasePanelCancel') as HTMLButtonElement).addEventListener('click', () => this.handleCancel());
		(root.querySelector('.rebasePanelApply') as HTMLButtonElement).addEventListener('click', () => this.handleApply());
	}

	private renderItem(item: GG.RebasePlanItem, index: number): HTMLLIElement {
		const li = document.createElement('li');
		li.className = 'rebasePanelItem';
		li.dataset.index = String(index);
		li.draggable = true;
		li.innerHTML =
			'<span class="rebasePanelHandle" title="Drag to reorder">&#x2630;</span>' +
			'<select class="rebasePanelAction"></select>' +
			'<span class="rebasePanelSubject" title="' + escapeHtml(item.subject) + '">' + escapeHtml(item.subject) + '</span>';

		const select = li.querySelector('.rebasePanelAction') as HTMLSelectElement;

		REBASE_PANEL_ACTIONS.forEach((value) => {
			const opt = document.createElement('option');
			opt.value = value;
			opt.textContent = value;
			if (value === item.action) opt.selected = true;
			select.appendChild(opt);
		});
		select.addEventListener('change', () => {
			const action = select.value as GG.RebaseAction;
			this.plan[index] = Object.assign({}, this.plan[index], { action: action });
		});

		li.addEventListener('dragstart', (event) => {
			if (event.dataTransfer !== null) {
				event.dataTransfer.setData('text/plain', String(index));
				event.dataTransfer.effectAllowed = 'move';
			}
			li.classList.add('rebasePanelDragging');
		});
		li.addEventListener('dragend', () => li.classList.remove('rebasePanelDragging'));
		li.addEventListener('dragover', (event) => {
			event.preventDefault();
			if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move';
			li.classList.add('rebasePanelDragOver');
		});
		li.addEventListener('dragleave', () => li.classList.remove('rebasePanelDragOver'));
		li.addEventListener('drop', (event) => {
			event.preventDefault();
			li.classList.remove('rebasePanelDragOver');
			const raw = event.dataTransfer !== null ? event.dataTransfer.getData('text/plain') : '';
			const from = parseInt(raw, 10);
			if (!isNaN(from) && from !== index) this.reorder(from, index);
		});

		return li;
	}

	private reorder(from: number, to: number) {
		const moved = this.plan.splice(from, 1)[0];
		this.plan.splice(to, 0, moved);
		this.rerenderList();
	}

	private rerenderList() {
		if (this.root === null) return;
		const list = this.root.querySelector('.rebasePanelList') as HTMLUListElement | null;
		if (list === null) return;
		list.innerHTML = '';
		this.plan.forEach((item, index) => list.appendChild(this.renderItem(item, index)));
	}

	private handleApply() {
		// git rejects a todo whose first non-drop entry is squash/fixup ("cannot
		// squash without a previous commit"), killing the rebase at startup.
		// The plan is in display order (newest first), so the offending entry is the LAST one.
		const lastApplied = [...this.plan].reverse().find((item) => item.action !== GG.RebaseAction.Drop);
		if (lastApplied !== undefined && (lastApplied.action === GG.RebaseAction.Squash || lastApplied.action === GG.RebaseAction.Fixup)) {
			this.showError('The last applied commit cannot be squashed or fixed up - there is no earlier commit to combine it with. Change it to pick, reword or edit, or reorder it.');
			return;
		}
		if (this.callbacks !== null) {
			// Plan is stored in display order (newest first); convert to git's natural
			// rebase order (oldest first) before handing it off to the backend.
			this.callbacks.onApply(this.plan.slice().reverse());
		}
	}

	private showError(message: string) {
		if (this.root === null) return;
		this.root.querySelector('.rebasePanelError')?.remove();
		const div = document.createElement('div');
		div.className = 'rebasePanelError';
		div.textContent = message;
		this.root.insertBefore(div, this.root.querySelector('footer'));
	}

	private handleCancel() {
		const cb = this.callbacks;
		this.close();
		if (cb !== null) cb.onCancel();
	}

	private removeRoot() {
		if (this.root !== null) {
			this.root.remove();
			this.root = null;
		}
	}
}
