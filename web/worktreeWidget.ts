interface WorktreeWidgetState {
	readonly currentRepo: string | null;
	readonly scrollTop: number;
}

/**
 * Implements the Git Graph View's Worktree Widget — a slide-in panel that lists
 * the repository's git worktrees and provides add / remove / prune / open actions.
 *
 * The worktree list is lazy-loaded: it is fetched via a `loadWorktrees` request
 * when the widget is shown (and re-fetched after each successful write action),
 * rather than being bundled into the regular repo-info preload.
 */
class WorktreeWidget {
	private readonly view: GitGraphView;

	private currentRepo: string | null = null;
	private worktrees: ReadonlyArray<GG.GitWorktree> = [];
	private loading: boolean = false;
	private loadError: GG.ErrorInfo = null;
	private scrollTop: number = 0;

	private readonly widgetElem: HTMLElement;
	private readonly contentsElem: HTMLElement;
	private readonly loadingElem: HTMLElement;

	/**
	 * Construct a new WorktreeWidget instance.
	 * @param view The Git Graph View that the WorktreeWidget is for.
	 */
	constructor(view: GitGraphView) {
		this.view = view;

		this.widgetElem = document.createElement('div');
		this.widgetElem.id = 'worktreeWidget';
		this.widgetElem.innerHTML = '<div id="worktreeHeader"><h2>Git Worktrees</h2><div id="worktreeClose"></div></div><div id="worktreeScrollWrap"><div id="worktreeContent"></div><div id="worktreeLoading"></div></div><div id="worktreeFooter"><div id="worktreeAddBtn" class="wt-footBtn" title="Add a new worktree">' + SVG_ICONS.plus + 'Add Worktree</div><div id="worktreePruneBtn" class="wt-footBtn secondary" title="Prune stale worktree entries">Prune</div></div>';
		document.body.appendChild(this.widgetElem);

		observeElemScroll('worktreeScrollWrap', this.scrollTop, (scrollTop) => {
			this.scrollTop = scrollTop;
		}, () => {
			if (this.currentRepo !== null) {
				this.view.saveState();
			}
		});

		this.contentsElem = document.getElementById('worktreeContent')!;
		this.loadingElem = document.getElementById('worktreeLoading')!;

		const worktreeClose = document.getElementById('worktreeClose')!;
		worktreeClose.innerHTML = SVG_ICONS.close;
		worktreeClose.addEventListener('click', () => this.close());

		document.getElementById('worktreeAddBtn')!.addEventListener('click', () => this.view.addWorktreeAction());
		document.getElementById('worktreePruneBtn')!.addEventListener('click', () => this.view.pruneWorktreesAction());
	}

	/**
	 * Show the Worktree Widget.
	 * @param currentRepo The repository that is currently loaded in the view.
	 * @param isInitialLoad Is this the initial load, or is it being shown when restoring a previous state.
	 * @param scrollTop The scrollTop the Worktree Widget should initially be set to.
	 */
	public show(currentRepo: string, isInitialLoad: boolean = true, scrollTop: number = 0) {
		if (this.currentRepo !== null) return;
		this.currentRepo = currentRepo;
		this.scrollTop = scrollTop;
		alterClass(this.widgetElem, CLASS_TRANSITION, isInitialLoad);
		this.widgetElem.classList.add(CLASS_ACTIVE);
		this.view.saveState();
		this.requestLoad();
	}

	/**
	 * Close the Worktree Widget, sliding it up out of view.
	 */
	public close() {
		if (this.currentRepo === null) return;
		this.currentRepo = null;
		this.worktrees = [];
		this.loading = false;
		this.loadError = null;
		this.widgetElem.classList.add(CLASS_TRANSITION);
		this.widgetElem.classList.remove(CLASS_ACTIVE);
		this.widgetElem.classList.remove(CLASS_LOADING);
		this.contentsElem.innerHTML = '';
		this.loadingElem.innerHTML = '';
		this.view.saveState();
	}

	/**
	 * Reload the worktree list. Called on show, after each successful write action,
	 * and when a refresh notification arrives while the widget is visible.
	 */
	public refresh() {
		if (this.currentRepo !== null) {
			this.requestLoad();
		}
	}

	/**
	 * Apply a `loadWorktrees` response to the widget.
	 * @param worktrees The worktrees returned by the backend.
	 * @param error The error returned by the backend (null on success).
	 */
	public setWorktrees(worktrees: ReadonlyArray<GG.GitWorktree>, error: GG.ErrorInfo) {
		this.loading = false;
		this.loadError = error;
		if (error === null) {
			this.worktrees = worktrees;
		} // on error, keep the previous list (do not blank the panel)
		this.render();
	}


	/* State */

	/**
	 * Get the current state of the Worktree Widget.
	 */
	public getState(): WorktreeWidgetState {
		return {
			currentRepo: this.currentRepo,
			scrollTop: this.scrollTop
		};
	}

	/**
	 * Restore the Worktree Widget to an existing state.
	 * @param state The previous Worktree Widget state.
	 */
	public restoreState(state: WorktreeWidgetState) {
		if (state.currentRepo === null) return;
		this.show(state.currentRepo, false, state.scrollTop);
	}

	/**
	 * Is the Worktree Widget currently visible.
	 */
	public isVisible() {
		return this.currentRepo !== null;
	}


	/* Internal */

	/**
	 * Send a `loadWorktrees` request and show the loading overlay until the response arrives.
	 */
	private requestLoad() {
		this.loading = true;
		this.render();
		sendMessage({ command: 'loadWorktrees', repo: this.currentRepo! });
	}


	/* Render Methods */

	/**
	 * Render the Worktree Widget.
	 */
	private render() {
		if (this.currentRepo === null) return;

		let html = '';
		if (this.loadError !== null && this.worktrees.length === 0) {
			// Initial load failed with no cached list — show the error placeholder.
			html = '<div class="wt-empty">' + SVG_ICONS.alert + '<div>Unable to load worktrees.</div><div class="wt-emptySub">' + escapeHtml(this.loadError) + '</div></div>';
		} else if (this.worktrees.length === 0 && !this.loading) {
			html = '<div class="wt-empty">No additional worktrees.</div>';
		} else {
			html += this.worktrees.map((wt) => this.renderRow(wt)).join('');
		}
		this.contentsElem.innerHTML = html;

		// Wire up the per-row action buttons.
		const visibility = this.view.getConfig().contextMenuActionsVisibility.worktree;
		const rows = this.contentsElem.getElementsByClassName('worktreeRow');
		for (let i = 0; i < rows.length; i++) {
			const row = <HTMLElement>rows[i];
			const path = row.dataset.path!;
			const isMain = row.dataset.isMain === '1';
			const isPrunable = row.dataset.isPrunable === '1';
			const onAction = (selector: string, fn: () => void) => {
				const btn = row.querySelector(selector);
				if (btn) btn.addEventListener('click', fn);
			};
			if (visibility.open) onAction('.wt-open', () => this.view.openWorktreeInNewWindow(path));
			if (visibility.remove && !isMain) onAction('.wt-remove', () => this.view.removeWorktreeAction(this.worktrees[i]));
			if (visibility.rename && !isMain) onAction('.wt-rename', () => this.view.renameWorktreeAction(this.worktrees[i]));
			if (visibility.copyPath) onAction('.wt-copy', () => this.view.copyWorktreePath(path));
			if (visibility.lock) onAction('.wt-lock', () => this.view.lockWorktreeAction(this.worktrees[i]));
			if (visibility.unlock) onAction('.wt-unlock', () => this.view.unlockWorktreeAction(this.worktrees[i]));
			// prunable rows have no working directory — disable open and rename
			if (isPrunable) {
				const openBtn = <HTMLElement>row.querySelector('.wt-open');
				if (openBtn) openBtn.classList.add('disabled');
				const renameBtn = <HTMLElement>row.querySelector('.wt-rename');
				if (renameBtn) renameBtn.classList.add('disabled');
			}
		}

		alterClass(this.widgetElem, CLASS_LOADING, this.loading);
		this.loadingElem.innerHTML = this.loading ? '<span>' + SVG_ICONS.loading + 'Loading ...</span>' : '';
	}

	/**
	 * Render a single worktree row.
	 */
	private renderRow(wt: GG.GitWorktree): string {
		const classes = ['worktreeRow'];
		if (wt.isMain) classes.push('isMain');
		if (wt.isCurrent) classes.push('isCurrent');
		if (wt.isPrunable) classes.push('isPrunable');

		const branchHtml = wt.isDetached || wt.branch === null
			? '<span class="wt-detached">(detached)</span>'
			: '<span class="wt-branch">' + SVG_ICONS.branch + escapeHtml(wt.branch) + '</span>';

		const tagHtml = wt.isMain
			? '<span class="wt-tag">main</span>'
			: (wt.isCurrent ? '<span class="wt-tag current">current</span>' : '');

		let badgesHtml = '';
		if (wt.isLocked) badgesHtml += '<span class="wt-badge locked" title="' + escapeHtml(wt.lockReason !== null ? 'Locked: ' + wt.lockReason : 'Locked') + '">' + SVG_ICONS.lock + '</span>';
		if (wt.isPrunable) badgesHtml += '<span class="wt-badge prunable" title="' + escapeHtml(wt.prunableReason !== null ? 'Prunable: ' + wt.prunableReason : 'Prunable') + '">' + SVG_ICONS.warning + '</span>';

		const visibility = this.view.getConfig().contextMenuActionsVisibility.worktree;
		let actionsHtml = '<div class="wt-actions">';
		if (visibility.open) actionsHtml += '<div class="wt-actionBtn wt-open" title="Open in New Window">' + SVG_ICONS.newWindow + '</div>';
		if (visibility.copyPath) actionsHtml += '<div class="wt-actionBtn wt-copy" title="Copy Path">' + SVG_ICONS.copy + '</div>';
		if (visibility.rename && !wt.isMain) actionsHtml += '<div class="wt-actionBtn wt-rename" title="Rename (Move) Worktree">' + SVG_ICONS.pencil + '</div>';
		if (visibility.lock && !wt.isLocked && !wt.isMain) actionsHtml += '<div class="wt-actionBtn wt-lock" title="Lock Worktree">' + SVG_ICONS.lock + '</div>';
		if (visibility.unlock && wt.isLocked && !wt.isMain) actionsHtml += '<div class="wt-actionBtn wt-unlock" title="Unlock Worktree">' + SVG_ICONS.unlock + '</div>';
		if (visibility.remove && !wt.isMain) actionsHtml += '<div class="wt-actionBtn wt-remove danger" title="Remove Worktree">' + SVG_ICONS.trash + '</div>';
		actionsHtml += '</div>';

		return '<div class="' + classes.join(' ') + '" data-path="' + escapeHtml(wt.path) + '" data-is-main="' + (wt.isMain ? 1 : 0) + '" data-is-prunable="' + (wt.isPrunable ? 1 : 0) + '" title="' + escapeHtml(wt.path) + '">' +
			'<div class="wt-main">' +
				'<div class="wt-path">' + escapeHtml(wt.path) + '</div>' +
				'<div class="wt-meta">' + branchHtml + tagHtml + '<div class="wt-badges">' + badgesHtml + '</div></div>' +
			'</div>' +
			actionsHtml +
		'</div>';
	}
}
