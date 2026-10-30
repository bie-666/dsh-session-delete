/**
 * dsh-session-delete — client half.
 *
 * Registers a "删除会话" item at the end of the sidebar session row menu
 * (`sidebar.workspaces.session.menu.item`) plus the confirmation dialog in
 * `shell.overlay` (the menu row unmounts as soon as the menu closes, so the
 * dialog cannot live inside it).
 *
 * rc.5 rules followed here:
 * - only `react` is required; no Harness Client package is imported as a module
 *   (`ctx.slots.register` rejects unknown slot names, and `require` of a package
 *   outside the module table throws and fails the whole web boot);
 * - the menu row and the modal copy the host markup and CSS, renamed under the
 *   `dshsd-` prefix and expressed with `--dsw-alias-*` / `--dsw-radius-*` tokens;
 * - the dialog calls the host route `POST /api/session-delete` (same-origin, so
 *   the browser session cookie authenticates it) and, when the deleted row is
 *   the conversation currently open, leaves that conversation.
 */
window.__ModuleLoader__.load({
	id: 'dsh-session-delete',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const React = require('react');
		const h = React.createElement;

		const NS = 'session-delete';
		const ROUTE = '/api/session-delete';

		/** Module-level uiWorkspace handle so post-delete navigation can leave a removed conversation. */
		let workspace = null;

		// ---------------------------------------------------------------------
		// locale
		// ---------------------------------------------------------------------

		const zh = {
			'menu.deleteSession': '删除会话',
			'confirm.title': '永久删除此会话？',
			'confirm.desc': '「{title}」将被永久删除，无法撤销：会话记录、消息与磁盘上的会话目录都会移除。',
			'confirm.untitled': '未命名会话',
			'confirm.action': '永久删除',
			'confirm.cancel': '取消',
			'confirm.pending': '正在删除…',
			'confirm.failed': '删除失败：{message}',
		};
		const en = {
			'menu.deleteSession': 'Delete session',
			'confirm.title': 'Delete this session permanently?',
			'confirm.desc': '“{title}” will be deleted for good: its transcript, messages and on-disk session directory are removed.',
			'confirm.untitled': 'Untitled session',
			'confirm.action': 'Delete permanently',
			'confirm.cancel': 'Cancel',
			'confirm.pending': 'Deleting…',
			'confirm.failed': 'Delete failed: {message}',
		};

		// ---------------------------------------------------------------------
		// pending request store (menu item raises, overlay dialog renders)
		// ---------------------------------------------------------------------

		let pending = null;
		const listeners = new Set();

		function subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}

		function readPending() {
			return pending;
		}

		function setPending(next) {
			if (pending === next) return;
			pending = next;
			for (const listener of [...listeners]) listener();
		}

		function usePending() {
			return React.useSyncExternalStore(subscribe, readPending, readPending);
		}

		// ---------------------------------------------------------------------
		// host call
		// ---------------------------------------------------------------------

		async function requestDelete(sessionId) {
			const response = await fetch(ROUTE, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ sessionId }),
			});
			let payload = null;
			try {
				payload = await response.json();
			} catch (failure) {
				payload = null;
			}
			if (payload === null || payload.ok !== true) {
				const code = (payload && payload.code) || 'http/' + response.status;
				const message = (payload && payload.message) || 'HTTP ' + response.status;
				throw new Error(message + ' (' + code + ')');
			}
			return payload;
		}

		// ---------------------------------------------------------------------
		// leaving the conversation that was just deleted
		// ---------------------------------------------------------------------

		function settleWorkspace(sessionId) {
			const service = workspace;
			if (service === null) return;
			try {
				if (service.mainReference?.sessionId !== sessionId) return;
			} catch (failure) {
				return;
			}
			try {
				service.startSession();
			} catch (failure) {
				try {
					service.clearMain();
				} catch (ignored) {
					/* best effort only */
				}
			}
		}

		// ---------------------------------------------------------------------
		// icons (inline, no host package imports)
		// ---------------------------------------------------------------------

		function TrashIcon() {
			return h(
				'svg',
				{ viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true', fill: 'currentColor' },
				h('path', {
					d: 'M6.2 1.5h3.6l.6 1.2h2.8v1.4H2.8V2.7h2.8l.6-1.2Zm-2.3 3.6h8.2l-.6 8.2a1.2 1.2 0 0 1-1.2 1.1H5.7a1.2 1.2 0 0 1-1.2-1.1l-.6-8.2Zm2.6 1.6v6.1h1.1V6.7H6.5Zm2.5 0v6.1h1.1V6.7H9Z',
				}),
			);
		}

		function CloseIcon() {
			return h(
				'svg',
				{ viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true', fill: 'currentColor' },
				h('path', {
					d: 'M8 6.6 12.3 2.3l1.4 1.4L9.4 8l4.3 4.3-1.4 1.4L8 9.4l-4.3 4.3-1.4-1.4L6.6 8 2.3 3.7 3.7 2.3 8 6.6Z',
				}),
			);
		}

		// ---------------------------------------------------------------------
		// styles: host markup copied, classes prefixed, theme tokens only
		// ---------------------------------------------------------------------

		const STYLE = [
			'.dshsd-item-wrap{position:relative}',
			'.dshsd-item{display:flex;align-items:center;gap:6px;width:100%;min-height:34px;padding:6px 8px;border:none;border-radius:var(--dsw-radius-md);background:transparent;cursor:pointer;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);text-align:left}',
			'.dshsd-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
			'.dshsd-item:focus-visible:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);outline:none}',
			'.dshsd-item:disabled{opacity:.4;cursor:not-allowed}',
			'.dshsd-item-icon{display:inline-flex;flex:none;width:14px;height:14px;align-items:center;justify-content:center;color:var(--dsw-alias-menu-icon)}',
			'.dshsd-item-icon svg{width:14px;height:14px}',
			'.dshsd-item-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.dshsd-danger,.dshsd-danger .dshsd-item-icon{color:var(--dsw-alias-state-error-primary)}',
			'.dshsd-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}',
			'.dshsd-danger:focus-visible:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);outline:none}',
			'.dshsd-overlay{pointer-events:auto;position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px}',
			'.dshsd-mask{position:absolute;inset:0;backdrop-filter:var(--dsw-mask-blur)}',
			'.dshsd-mask:after{content:"";position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1)}',
			'.dshsd-dialog{box-sizing:border-box;position:relative;z-index:1;display:flex;flex-direction:column;gap:20px;width:min(420px,100%);padding:0 0 24px;overflow:hidden;border:0;border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent)}',
			'.dshsd-dialog:focus{outline:none}',
			'.dshsd-content{display:flex;flex-direction:column;width:100%}',
			'.dshsd-header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:22px 14px 12px 24px}',
			'.dshsd-title{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}',
			'.dshsd-close{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary)}',
			'.dshsd-close:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
			'.dshsd-close:disabled{cursor:not-allowed;opacity:.4}',
			'.dshsd-description{margin:0;padding:0 24px;font-size:14px;line-height:22px;font-weight:400;color:var(--dsw-alias-label-primary)}',
			'.dshsd-error{margin:12px 24px 0;padding:8px 10px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px}',
			'.dshsd-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:0 24px}',
			'.dshsd-button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:36px;border:none;border-radius:var(--dsw-radius-md);cursor:pointer;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);background:transparent;padding:0 14px}',
			'.dshsd-button:disabled{cursor:not-allowed;opacity:.4}',
			'.dshsd-outline{border:.5px solid var(--dsw-alias-border-l3);background:transparent}',
			'.dshsd-outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
			'.dshsd-action-danger{color:var(--dsw-alias-state-error-primary)}',
			'.dshsd-action-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}',
		].join('\n');

		function ensureStyles() {
			const existing = document.querySelector('style[data-plugin-css="dsh-session-delete"]');
			if (existing !== null) return () => {};
			const tag = document.createElement('style');
			tag.dataset.pluginCss = 'dsh-session-delete';
			tag.textContent = STYLE;
			document.head.appendChild(tag);
			return () => {
				tag.remove();
			};
		}

		// ---------------------------------------------------------------------
		// session row menu entry
		// ---------------------------------------------------------------------

		function DeleteSessionMenuItem(props) {
			// The slot declares a `menuOpenState` hook; the renderer hands it over as a prop.
			const openState = typeof props.useMenuOpenState === 'function' ? props.useMenuOpenState() : null;
			const closeMenu = () => {
				if (Array.isArray(openState) && typeof openState[1] === 'function') openState[1](false);
			};
			const t = typeof props.t === 'function' ? props.t : (key) => key;
			return h(
				React.Fragment,
				null,
				h(
					'div',
					{ className: 'dshsd-item-wrap' },
					h(
						'button',
						{
							type: 'button',
							role: 'menuitem',
							className: 'dshsd-item dshsd-danger',
							onClick: () => {
								closeMenu();
								setPending({ sessionId: props.sessionId, displayTitle: props.displayTitle });
							},
						},
						h('span', { className: 'dshsd-item-icon' }, h(TrashIcon)),
						h('span', { className: 'dshsd-item-label' }, t('menu.deleteSession')),
					),
				),
			);
		}

		// ---------------------------------------------------------------------
		// shell.overlay confirmation dialog
		// ---------------------------------------------------------------------

		function DeleteSessionDialog(props) {
			const request = usePending();
			if (request === null) return null;
			const t = typeof props.t === 'function' ? props.t : (key) => key;
			return h(DeleteSessionForm, { key: request.sessionId, request, t });
		}

		function DeleteSessionForm({ request, t }) {
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState(null);

			const close = React.useCallback(() => {
				if (busy) return;
				setPending(null);
			}, [busy]);

			React.useEffect(() => {
				const onKeyDown = (event) => {
					if (event.key !== 'Escape' || event.shiftKey) return;
					event.preventDefault();
					close();
				};
				document.addEventListener('keydown', onKeyDown, true);
				return () => document.removeEventListener('keydown', onKeyDown, true);
			}, [close]);

			const confirm = async () => {
				if (busy) return;
				setBusy(true);
				setError(null);
				try {
					await requestDelete(request.sessionId);
					setPending(null);
					settleWorkspace(request.sessionId);
				} catch (failure) {
					setError(String((failure && failure.message) || failure));
				} finally {
					setBusy(false);
				}
			};

			return h(
				React.Fragment,
				null,
				h(
					'div',
					{ className: 'dshsd-overlay', role: 'presentation' },
					h('div', { className: 'dshsd-mask', 'aria-hidden': 'true', onClick: close }),
					h(
						'div',
						{
							className: 'dshsd-dialog',
							role: 'dialog',
							'aria-modal': 'true',
							'aria-label': t('confirm.title'),
							tabIndex: -1,
						},
						h(
							'div',
							{ className: 'dshsd-content' },
							h(
								'div',
								{ className: 'dshsd-header' },
								h('h2', { className: 'dshsd-title' }, t('confirm.title')),
								h(
									'button',
									{
										type: 'button',
										className: 'dshsd-close',
										'aria-label': t('confirm.cancel'),
										disabled: busy,
										onClick: close,
									},
									h(CloseIcon),
								),
							),
							h('p', { className: 'dshsd-description' }, t('confirm.desc', { title: request.displayTitle || t('confirm.untitled') })),
							error === null
								? null
								: h('p', { className: 'dshsd-error', role: 'alert' }, t('confirm.failed', { message: error })),
						),
						h(
							'div',
							{ className: 'dshsd-footer' },
							h('button', { type: 'button', className: 'dshsd-button dshsd-outline', disabled: busy, onClick: close }, t('confirm.cancel')),
							h(
								'button',
								{
									type: 'button',
									className: 'dshsd-button dshsd-outline dshsd-action-danger',
									disabled: busy,
									onClick: confirm,
								},
								busy ? t('confirm.pending') : t('confirm.action'),
							),
						),
					),
				),
			);
		}

		// ---------------------------------------------------------------------
		// plugin entry
		// ---------------------------------------------------------------------

		function apply(ctx) {
			workspace = ctx.get('uiWorkspace') ?? null;

			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-delete: locale dictionaries');
			ctx.effect(ensureStyles, 'session-delete: stylesheet');

			ctx.slots.inject('sidebar.workspaces.session.menu.item', function* () {
				yield ctx.slots.register(
					{
						name: 'sidebar.workspaces.session.menu.item',
						id: 'session-delete.delete',
						order: 500,
						locale: NS,
					},
					DeleteSessionMenuItem,
				);
			});

			ctx.slots.inject('shell.overlay', function* () {
				yield ctx.slots.register(
					{
						name: 'shell.overlay',
						id: 'session-delete.dialog',
						order: 900,
						locale: NS,
					},
					DeleteSessionDialog,
				);
			});
		}


		exports.apply = apply;
		exports.inject = ['slots', 'locale', 'uiWorkspace'];
		return module.exports;
	},
});
