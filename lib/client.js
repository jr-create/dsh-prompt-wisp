/**
 * dsh-prompt-wisp — browser half.
 *
 * Hand-authored in the client module format DSH's `client-modules` service
 * expects: a plain script that registers one lazy CommonJS factory with
 * `window.__ModuleLoader__.load({ id, factory })`. The `id` must be the exact
 * package name, because the loader matches a served bundle against the entry
 * it was fetched for. No bundler is involved; React arrives through the
 * factory's `require`.
 *
 * The UI is one button in the official `conversation.input.right` slot — the
 * compact controls row just left of the composer's submit action. The slot
 * runtime hands every session-scoped component the session standard props, so
 * the button reads the draft with `props.useInput(s => s.draft)` and writes
 * the optimized text back with `props.inputActions.setDraft(text)` — never by
 * touching the editor DOM.
 *
 * The optimization runs in the host: the browser posts the draft to
 * `/api/dsh-prompt-wisp/optimize` and the host calls its own configured model
 * through `ctx.llm.stream()`, so no API key or provider logic exists here.
 */

window.__ModuleLoader__.load({
  id: 'dsh-prompt-wisp',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require('react');

    var h = React.createElement;
    var API_BASE = '/api/dsh-prompt-wisp';

    /* ------------------------------------------------------------------ i18n */

    // Self-contained two-language support, same approach as dsh-session-vault:
    // detect the navigator language instead of depending on the locale
    // service's registration lifecycle for a handful of strings.
    var PREFERS_CHINESE = (function detectChinese() {
      try {
        var languages = navigator.languages && navigator.languages.length > 0
          ? navigator.languages
          : [navigator.language || ''];
        for (var index = 0; index < languages.length; index += 1) {
          if (String(languages[index]).toLowerCase().indexOf('zh') === 0) return true;
        }
      } catch (error) {
        return false;
      }
      return false;
    })();

    /** Pick the Chinese or English string. */
    function t(chinese, english) {
      return PREFERS_CHINESE ? chinese : english;
    }

    /* ------------------------------------------------------------------- api */

    /**
     * Call one host endpoint and unwrap its `{ ok, ... }` envelope.
     *
     * The response is read as text first so a non-JSON body can be *reported*
     * rather than discarded: a body that is not our JSON envelope almost
     * always means the route never registered and the /api RPC fence answered
     * instead (a bare-text 401/403) — the status and the body are the only
     * things that make that diagnosable.
     *
     * @param {string} path - path below the shared route prefix.
     * @param {RequestInit} [init] - optional fetch init.
     * @returns {Promise<object>} the response envelope.
     */
    async function api(path, init) {
      var response = await fetch(API_BASE + path, init);
      var text = await response.text();
      var payload;
      try {
        payload = text.length === 0 ? undefined : JSON.parse(text);
      } catch (error) {
        payload = undefined;
      }
      if (payload === null || typeof payload !== 'object') {
        throw new Error(
          'HTTP ' + response.status + (response.statusText ? ' ' + response.statusText : '')
          + ' — ' + (text.slice(0, 160) || t('（空响应）', '(empty body)')),
        );
      }
      if (payload.ok !== true) {
        throw new Error(payload.error || ('HTTP ' + response.status));
      }
      return payload;
    }

    /** POST a JSON body. */
    function postJson(path, body) {
      return api(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body === undefined ? {} : body),
      });
    }

    /* ------------------------------------------------------------- the button */

    /** Idle glyph and label; a ✨ sparkle reads well in both themes. */
    var GLYPH = '✦';

    /**
     * One optimizable draft: non-empty and not already an optimization run.
     * @param {string} draft - current composer draft.
     * @returns {boolean} whether the button is enabled.
     */
    function draftIsOptimizable(draft) {
      return typeof draft === 'string' && draft.trim().length > 0;
    }

    /**
     * The optimize button for one session's composer.
     *
     * Props come from the slot runtime's standard session kit: `useInput`
     * subscribes to the input machine (draft text), `inputActions` mutates it
     * (`setDraft`), `sessionId` identifies the session. Everything the
     * component renders derives from those.
     *
     * @param {object} props - standard session slot props.
     * @returns {React.Element} the button, or `null` while input is absent.
     */
    function WispOptimizeButton(props) {
      var useInput = props && props.useInput;
      var inputActions = props ? props.inputActions : undefined;
      var sessionId = props ? props.sessionId : undefined;
      var draft = typeof useInput === 'function' ? useInput(function (state) { return state.draft; }) : '';

      var [busy, setBusy] = React.useState(false);
      var [error, setError] = React.useState(null);
      var [applied, setApplied] = React.useState(false);
      var [grounded, setGrounded] = React.useState(false);

      // The confirmation toast/panel is transient: clear it when the draft
      // changes again (the user kept editing) or after a short delay.
      React.useEffect(function () {
        if (!applied) return undefined;
        var timer = window.setTimeout(function () { setApplied(false); }, 4000);
        return function () { window.clearTimeout(timer); };
      }, [applied]);

      var disabled = busy || !draftIsOptimizable(draft);

      async function run() {
        if (busy || !draftIsOptimizable(draft)) return;
        setBusy(true);
        setError(null);
        setApplied(false);
        setGrounded(false);
        try {
          // The session id lets the host ground the rewrite in this
          // session's recent conversation (read host-side through
          // `sessionPersistence`); it is optional — an absent or unknown
          // session still optimizes on the draft alone.
          var payload = await postJson('/optimize', {
            prompt: draft,
            sessionId: typeof sessionId === 'string' ? sessionId : undefined,
          });
          var optimized = typeof payload.optimized === 'string' ? payload.optimized : '';
          if (optimized.length === 0) {
            throw new Error(t('模型返回了空结果', 'the model returned an empty result'));
          }
          // Write the optimized prompt back through the official input
          // actions — never through the editor DOM.
          if (inputActions && typeof inputActions.setDraft === 'function') {
            inputActions.setDraft(optimized);
          } else {
            throw new Error(t('当前会话不支持写入输入框', 'this session does not allow draft writes'));
          }
          setGrounded(payload.contextUsed === true);
          setApplied(true);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }

      // While input state is absent (no session) render nothing — the slot
      // also guards this, but the cheap check keeps the component total.
      if (typeof useInput !== 'function' || !inputActions) return null;

      var title = busy
        ? t('正在优化…', 'Optimizing…')
        : (draftIsOptimizable(draft)
          ? t('让 AI 把草稿改写成更清晰的提示词', 'Rewrite the draft into a clearer prompt')
          : t('先写点内容再优化', 'Write something first'));

      return h('div', { className: 'dpw-wrap' },
        h('button', {
          type: 'button',
          className: 'dpw-btn',
          'data-busy': busy ? 'true' : undefined,
          title: title,
          'aria-label': title,
          disabled: disabled,
          onMouseDown: function (event) { event.preventDefault(); },
          onClick: function () { run(); },
        }, busy ? h('span', { className: 'dpw-spinner', 'aria-hidden': 'true' }) : GLYPH),
        (error || applied) && h('div', {
          className: 'dpw-pop',
          'data-kind': error ? 'error' : 'ok',
          role: 'status',
        },
        error
          ? [
            h('div', { key: 'm', className: 'dpw-pop-msg' }, t('优化失败：', 'Optimization failed: ') + error),
            h('button', {
              key: 'x',
              type: 'button',
              className: 'dpw-pop-close',
              onClick: function () { setError(null); },
              'aria-label': t('关闭', 'Dismiss'),
            }, '×'),
          ]
          : [
            h('div', { key: 'm', className: 'dpw-pop-msg' },
              t('已把优化结果写入输入框', 'Optimized draft written to the composer')
              + (grounded ? t('（已结合会话上下文）', ' (grounded in session context)') : '')),
            h('button', {
              key: 'x',
              type: 'button',
              className: 'dpw-pop-close',
              onClick: function () { setApplied(false); },
              'aria-label': t('关闭', 'Dismiss'),
            }, '×'),
          ]),
      );
    }

    /* ----------------------------------------------------------------- styles */

    // Every theme reference carries a literal fallback: a `var()` with no
    // fallback silently drops the whole declaration when the token is
    // missing, and `--dsw-alias-brand-primary` is white in the dark theme —
    // the paired foreground token is the only correct partner for a
    // brand-filled surface (dsh-session-vault, stylesheet contract).
    var CSS = [
      '.dpw-wrap{position:relative;display:inline-flex;align-items:center}',
      '.dpw-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;'
        + 'width:26px;height:26px;padding:0;border-radius:6px;cursor:pointer;font:inherit;font-size:13px;line-height:1;'
        + 'color:var(--dpw-fg,var(--dsw-alias-label-secondary,#9b9ba3));'
        + 'background:transparent;border:1px solid transparent;}',
      '.dpw-btn:hover:not(:disabled){color:var(--dpw-accent,var(--dsw-alias-brand-primary,#4d6bfe));'
        + 'background:var(--dpw-hover,var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05)));'
        + 'border-color:var(--dpw-line,var(--dsw-alias-border-l1,#2f2f34));}',
      '.dpw-btn:focus-visible{outline:2px solid var(--dpw-accent,var(--dsw-alias-brand-primary,#4d6bfe));outline-offset:1px;}',
      '.dpw-btn:disabled{opacity:.4;cursor:not-allowed;}',
      '.dpw-btn[data-busy="true"]{color:var(--dpw-accent,var(--dsw-alias-brand-primary,#4d6bfe));}',
      '.dpw-spinner{width:12px;height:12px;border-radius:50%;'
        + 'border:2px solid var(--dpw-line-2,var(--dsw-alias-border-l2,#3b3b41));'
        + 'border-top-color:var(--dpw-accent,var(--dsw-alias-brand-primary,#4d6bfe));'
        + 'animation:dpw-spin .8s linear infinite;}',
      '@keyframes dpw-spin{to{transform:rotate(360deg)}}',
      // The popover is absolutely positioned so it never pushes the tool row;
      // it anchors to the right edge and reads above the row.
      '.dpw-pop{position:absolute;right:0;bottom:calc(100% + 8px);z-index:60;max-width:320px;'
        + 'display:flex;align-items:flex-start;gap:6px;padding:8px 10px;border-radius:8px;'
        + 'font-size:12px;line-height:1.5;white-space:normal;word-break:break-word;'
        + 'background:var(--dpw-surface,var(--dsw-alias-bg-layer-2,#232327));'
        + 'color:var(--dpw-fg,var(--dsw-alias-label-primary,#e9e9ec));'
        + 'border:1px solid var(--dpw-line,var(--dsw-alias-border-l1,#2f2f34));'
        + 'box-shadow:0 6px 24px rgba(0,0,0,.25);}',
      '.dpw-pop[data-kind="error"]{border-color:var(--dpw-error,var(--dsw-alias-state-error-primary,#f2555a));}',
      '.dpw-pop[data-kind="ok"]{border-color:var(--dpw-ok,var(--dsw-alias-state-success-primary,#3ecf8e));}',
      '.dpw-pop-msg{flex:1 1 auto;min-width:0;}',
      '.dpw-pop-close{appearance:none;border:0;background:transparent;color:inherit;font:inherit;'
        + 'cursor:pointer;padding:0 2px;opacity:.6;flex:none;}',
      '.dpw-pop-close:hover{opacity:1;}',
    ].join('\n');

    /** Install the stylesheet once per client root. */
    function installStyles() {
      if (typeof document === 'undefined') return;
      var id = 'dsh-prompt-wisp-styles';
      if (document.getElementById(id) !== null) return;
      var element = document.createElement('style');
      element.id = id;
      element.textContent = CSS;
      document.head.appendChild(element);
    }

    /* ----------------------------------------------------------------- plugin */

    const inject = ['slots'];

    /**
     * Register the composer button.
     *
     * `conversation.input.right` is declared by the conversation UI package;
     * the deferred `ctx.slots.inject` fires whenever that declaration
     * commits, before or after this fiber starts — the same seam discipline
     * dsh-workbuddy-connect's probe control uses.
     *
     * @param {object} ctx - the client root context.
     */
    function apply(ctx) {
      installStyles();
      ctx.slots.inject('conversation.input.right', function register() {
        return ctx.slots.register({
          name: 'conversation.input.right',
          id: 'prompt-wisp',
          order: 10,
        }, WispOptimizeButton);
      });
    }

    exports.apply = apply;
    exports.inject = inject;

    return module.exports;
  },
});
