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

    /* ----------------------------------------------------------- session watch */

    /** Watch poll interval while a session is visible, in ms. */
    var WATCH_POLL_MS = 5000;
    /** Findings older than this stop rendering (stale analysis). */
    var WATCH_MAX_FINDINGS = 3;

    /**
     * Poll the host watch endpoint for one session's execution health.
     *
     * Polling (rather than push) keeps the client half trivial: the host
     * already owns the log tail reader, and a 5s cadence is ample for
     * detecting 45s-scale stalls. The poll pauses when the tab is hidden —
     * background tabs do not need to know the session is stuck.
     *
     * @param {string|undefined} sessionId - the session to watch.
     * @param {Function} onData - called with `{ status, findings, reason }`.
     * @returns {object} React effect cleanup.
     */
    function useSessionWatch(sessionId, onData) {
      React.useEffect(function () {
        if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
        var timer = null;
        var stopped = false;
        async function poll() {
          if (stopped) return;
          if (typeof document !== 'undefined' && document.hidden === true) {
            schedule();
            return;
          }
          try {
            var response = await fetch(`${API_BASE}/watch?sessionId=${encodeURIComponent(sessionId)}`);
            var payload = await response.json();
            if (!stopped && payload && typeof payload === 'object') onData(payload);
          } catch (failure) {
            // The watch is auxiliary; a failed poll is silently retried.
          }
          schedule();
        }
        function schedule() {
          if (stopped) return;
          timer = window.setTimeout(poll, WATCH_POLL_MS);
        }
        poll();
        return function cleanup() {
          stopped = true;
          if (timer !== null) window.clearTimeout(timer);
        };
      }, [sessionId, onData]);
      return null;
    }

    /**
     * The session-watch banner, registered in the official
     * `conversation.input.dock` slot — the full-width strip ABOVE the
     * composer card.
     *
     * Position rationale: the ✦ button is 26px wide inside the tool row, so
     * any popover anchored to it covers the input field or the transcript —
     * exactly what the user complained about. `input.dock` is in the normal
     * document flow above the composer: it never overlays anything, it is
     * full width (findings read as text, not a cramped tooltip), and it is
     * where the user's eyes already are while a session runs.
     *
     * The banner renders only when the analysis has findings worth showing;
     * healthy and unknown states stay invisible. Dismissal hides the
     * findings until the next poll CHANGES the finding set (a new finding
     * must not be swallowed by a stale dismissal), keyed on the messages.
     *
     * @param {object} props - standard session slot props.
     * @returns {React.Element} the banner, or `null` when nothing to show.
     */
    function WispWatchBanner(props) {
      var sessionId = props ? props.sessionId : undefined;
      var [watch, setWatch] = React.useState(null);
      var [dismissedKey, setDismissedKey] = React.useState('');
      var [bannerEnabled, setBannerEnabled] = React.useState(null);

      // The show/hide switch is read once per banner mount and re-checked
      // every poll cycle — turning it on in settings takes effect within a
      // poll interval, turning it off hides the banner immediately.
      var refreshBannerFlag = React.useCallback(function reload() {
        fetch(`${API_BASE}/config`)
          .then(function loaded(response) { return response.json(); })
          .then(function parsed(body) {
            if (body && typeof body === 'object') {
              setBannerEnabled(body.config.showWatchBanner !== false);
            }
          })
          .catch(function failed() {
            // A failed config read leaves the last known flag in place.
          });
      }, []);
      React.useEffect(function onMount() { refreshBannerFlag(); }, [refreshBannerFlag]);

      var onData = React.useCallback(function callback(payload) {
        setWatch(payload);
        // Re-check the switch on every poll: settings changes apply within
        // one 5s interval without a page reload.
        refreshBannerFlag();
      }, [refreshBannerFlag]);
      useSessionWatch(sessionId, onData);

      var findings = watch && Array.isArray(watch.findings) ? watch.findings.slice(0, WATCH_MAX_FINDINGS) : [];
      var worst = watch && typeof watch.status === 'string' ? watch.status : 'unknown';
      var showable = bannerEnabled !== false
        && (worst === 'warn' || worst === 'alert')
        && findings.length > 0;
      var findingsKey = findings.map(function (finding) { return finding.kind + ':' + finding.message; }).join('|');

      // A dismissal is forgotten as soon as the finding set changes, so a
      // NEW finding always re-surfaces.
      var visible = showable && findingsKey !== dismissedKey;

      if (!visible) return null;

      return h('div', {
        className: 'dpw-banner',
        'data-kind': worst === 'alert' ? 'alert' : 'warn',
        role: 'alert',
      },
      h('span', { className: 'dpw-banner-icon', 'aria-hidden': 'true' }, worst === 'alert' ? '⛔' : '⚠️'),
      h('div', { className: 'dpw-banner-msg' },
        findings.map(function renderFinding(finding, index) {
          return h('div', { key: index }, finding.message);
        })),
      h('button', {
        type: 'button',
        className: 'dpw-banner-close',
        onClick: function () { setDismissedKey(findingsKey); },
        'aria-label': t('关闭', 'Dismiss'),
      }, '×'));
    }

    /**
     * The optimize button for one session's composer.
     *
     * Props come from the slot runtime's standard session kit: `useInput`
     * subscribes to the input machine (draft text), `inputActions` mutates it
     * (`setDraft`), `sessionId` identifies the session.
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
      // ---- session watch banner (lives in conversation.input.dock —
      // full-width, in-flow above the composer; never overlays anything) ----
      '.dpw-banner{display:flex;align-items:flex-start;gap:10px;padding:10px 14px;'
        + 'border-radius:8px;font-size:12.5px;line-height:1.55;'
        + 'border:1px solid var(--dpw-line-2,var(--dsw-alias-border-l2,#3b3b41));'
        + 'background:var(--dpw-surface,var(--dsw-alias-bg-layer-2,#232327));'
        + 'color:var(--dpw-fg,var(--dsw-alias-label-primary,#e9e9ec));}',
      '.dpw-banner[data-kind="warn"]{border-color:var(--dpw-warn,var(--dsw-alias-state-warn-primary,#f5a524));}',
      '.dpw-banner[data-kind="alert"]{border-color:var(--dpw-error,var(--dsw-alias-state-error-primary,#f2555a));}',
      '.dpw-banner-icon{flex:none;font-size:14px;line-height:1.4;}',
      '.dpw-banner-msg{flex:1 1 auto;min-width:0;word-break:break-word;}',
      '.dpw-banner-close{appearance:none;border:0;background:transparent;color:inherit;font:inherit;'
        + 'cursor:pointer;padding:0 2px;opacity:.55;flex:none;}',
      '.dpw-banner-close:hover{opacity:1;}',
      // ---- settings page ----
      '.dpw-root{display:flex;flex-direction:column;gap:16px;padding:4px 0 32px;'
        + 'color:var(--dpw-fg,var(--dsw-alias-label-primary,#e9e9ec));font-size:13px;line-height:1.5;}',
      '.dpw-title{margin:0;font-size:16px;font-weight:600;}',
      '.dpw-sub{margin:4px 0 0;color:var(--dpw-fg-dim,var(--dsw-alias-label-secondary,#9b9ba3));font-size:12px;}',
      '.dpw-card{border:1px solid var(--dpw-line,var(--dsw-alias-border-l1,#2f2f34));border-radius:8px;'
        + 'padding:14px 16px;display:flex;flex-direction:column;gap:10px;'
        + 'background:var(--dpw-surface,var(--dsw-alias-bg-layer-1,#1b1b1e));}',
      '.dpw-opt{display:flex;align-items:flex-start;gap:10px;}',
      '.dpw-opt-text{flex:1 1 auto;min-width:0;}',
      '.dpw-opt-name{font-weight:600;}',
      '.dpw-opt-default{margin-left:8px;font-weight:400;font-size:11px;'
        + 'color:var(--dpw-fg-dim,var(--dsw-alias-label-secondary,#9b9ba3));}',
      '.dpw-opt-desc{margin:2px 0 0;color:var(--dpw-fg-dim,var(--dsw-alias-label-secondary,#9b9ba3));font-size:12px;}',
      '.dpw-group-title{font-size:12px;font-weight:600;letter-spacing:.02em;'
        + 'color:var(--dpw-fg-dim,var(--dsw-alias-label-secondary,#9b9ba3));text-transform:uppercase;}',
      '.dpw-switch{appearance:none;position:relative;width:36px;height:20px;flex:none;margin-top:2px;'
        + 'border-radius:10px;border:1px solid var(--dpw-line-2,var(--dsw-alias-border-l2,#3b3b41));'
        + 'background:var(--dpw-surface-2,var(--dsw-alias-bg-layer-2,#232327));cursor:pointer;transition:background .15s;}',
      '.dpw-switch:checked{background:var(--dpw-accent,var(--dsw-alias-brand-primary,#4d6bfe));'
        + 'border-color:var(--dpw-accent,var(--dsw-alias-brand-primary,#4d6bfe));}',
      '.dpw-switch::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;'
        + 'background:var(--dpw-accent-fg,var(--dsw-alias-label-primary-foreground,#fff));transition:left .15s;}',
      '.dpw-switch:checked::after{left:18px;}',
      '.dpw-btn{appearance:none;font:inherit;border-radius:6px;padding:6px 14px;cursor:pointer;'
        + 'border:1px solid var(--dpw-line-2,var(--dsw-alias-border-l2,#3b3b41));'
        + 'background:var(--dpw-surface-2,var(--dsw-alias-bg-layer-2,#232327));'
        + 'color:var(--dpw-fg,var(--dsw-alias-label-primary,#e9e9ec));white-space:nowrap;}',
      '.dpw-btn:hover:not(:disabled){border-color:var(--dpw-accent,var(--dsw-alias-brand-primary,#4d6bfe));}',
      '.dpw-btn:disabled{opacity:.45;cursor:not-allowed;}',
      '.dpw-note{margin:0;font-size:12px;white-space:pre-wrap;word-break:break-word;}',
      '.dpw-note[data-kind="error"]{color:var(--dpw-error,var(--dsw-alias-state-error-primary,#f2555a));}',
      '.dpw-note[data-kind="ok"]{color:var(--dpw-ok,var(--dsw-alias-state-success-primary,#3ecf8e));}',
      '.dpw-hint{font-size:11.5px;color:var(--dpw-fg-dim,var(--dsw-alias-label-secondary,#9b9ba3));'
        + 'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}',
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

    /* --------------------------------------------------------- settings page */

    /**
     * Normalize a config document on the client side, mirroring the host's
     * normalizeConfig — every known key resolves to a boolean, so the switches
     * always render a definite state.
     * @param {object|undefined} raw - the document from /config.
     * @returns {object} the six-key config.
     */
    function normalizeClientConfig(raw) {
      var source = raw !== null && typeof raw === 'object' ? raw : {};
      return {
        trimFiller: source.trimFiller === true,
        detailMode: source.detailMode === true,
        showWatchBanner: source.showWatchBanner !== false,
        watchStall: source.watchStall !== false,
        watchNoOutput: source.watchNoOutput !== false,
        watchToolLoop: source.watchToolLoop !== false,
      };
    }

    /** The optimizer group: two mode switches, copy in one place. */
    var MODES = [
      {
        key: 'trimFiller',
        name: t('去废话', 'Trim filler'),
        desc: t('剔除草稿里的客套话、寒暄、重复与空洞修饰，只留有实际内容的指令。简便与详细模式都生效。',
          'Strip politeness, small talk, repetition and empty embellishment; keep only instructions that carry content. Applies to both modes.'),
      },
      {
        key: 'detailMode',
        name: t('详细优化', 'Detailed optimization'),
        desc: t('默认是简便优化：精简提示词 + 多模型竞速，约 0.5~1.5 秒。开启后走详细优化：完整结构化提示词 + 会话上下文，1~4 秒。',
          'Default is compact optimization: lean prompt + model race, ~0.5-1.5s. When on: full structured prompt + session context, 1-4s.'),
      },
    ];

    /** The session-watch group: banner + three detection rules. */
    var WATCH_OPTIONS = [
      {
        key: 'showWatchBanner',
        name: t('显示会话监控告警条', 'Show session watch banner'),
        desc: t('在输入区上方显示执行异常告警条。关闭后完全隐藏（轮询也停止）。默认：开。',
          'Show the execution-findings banner above the composer. When off it is fully hidden (polling stops too). Default: on.'),
      },
      {
        key: 'watchStall',
        name: t('卡死 / 死锁检测', 'Stall / deadlock detection'),
        desc: t('回合进行中超过 45 秒没有任何新事件时告警（工具挂起、模型无响应）。默认：开。',
          'Alert when an open turn has no new events for 45s (hung tool, unresponsive model). Default: on.'),
      },
      {
        key: 'watchNoOutput',
        name: t('无效输出检测', 'No-output detection'),
        desc: t('回合已执行 8 步以上却没有任何可见文本时告警（无意义空转）。默认：开。',
          'Alert when a turn runs 8+ steps with no visible text (meaningless spinning). Default: on.'),
      },
      {
        key: 'watchToolLoop',
        name: t('工具循环检测', 'Tool-loop detection'),
        desc: t('同一工具以几乎相同的参数连续调用 5 次时告警（参数按 GUID/数字/空白归一化后比较）。默认：开。',
          'Alert when the same tool is called 5 times with near-identical arguments (GUIDs/counters/whitespace normalized). Default: on.'),
      },
    ];

    /**
     * The plugin's settings page: every feature in one place, one independent
     * switch per option, grouped (优化 / 会话监控), one Save.
     *
     * The page loads the persisted config once, edits a local copy, and saves
     * the whole document on click — no per-toggle network traffic, and the
     * switches always show what a save would write.
     *
     * @param {object} props - settings.section owner props (close()).
     * @returns {React.Element} the page.
     */
    function WispSettingsSection(props) {
      var [config, setConfig] = React.useState(null);
      var [saved, setSaved] = React.useState(null);
      var [error, setError] = React.useState(null);
      var [busy, setBusy] = React.useState(false);
      var [persisted, setPersisted] = React.useState(true);

      React.useEffect(function onMount() {
        api('/config')
          .then(function loaded(result) {
            setConfig(normalizeClientConfig(result.config));
            setPersisted(result.persisted === true);
          })
          .catch(function failed(failure) {
            setError(failure && failure.message ? failure.message : String(failure));
            // Still render the switches on defaults; the save retries.
            setConfig(normalizeClientConfig(undefined));
          });
      }, []);

      function toggle(key) {
        setConfig(function previous(current) {
          return { ...current, [key]: !current[key] };
        });
      }

      async function save() {
        if (busy || config === null) return;
        setBusy(true);
        setError(null);
        try {
          var result = await postJson('/config', config);
          setConfig(normalizeClientConfig(result.config));
          setPersisted(true);
          setSaved(t('已保存 — 立即生效（告警条显隐在下一个轮询周期内应用）。', 'Saved — applies immediately (banner visibility within one poll interval).'));
        } catch (failure) {
          setError(failure && failure.message ? failure.message : String(failure));
        } finally {
          setBusy(false);
        }
      }

      function renderGroup(title, options) {
        return h('div', { className: 'dpw-card' },
          h('div', { className: 'dpw-group-title' }, title),
          options.map(function renderOption(option) {
            return h('label', { key: option.key, className: 'dpw-opt' },
              h('span', { className: 'dpw-opt-text' },
                h('span', { className: 'dpw-opt-name' },
                  option.name,
                  h('span', { className: 'dpw-opt-default' },
                    t('默认：' + (option.defaultValue ? '开' : '关'), 'Default: ' + (option.defaultValue ? 'on' : 'off')))),
                h('p', { className: 'dpw-opt-desc' }, option.desc)),
              h('input', {
                type: 'checkbox',
                className: 'dpw-switch',
                checked: config !== null && config[option.key] === true,
                disabled: config === null || busy,
                onChange: function change() { toggle(option.key); },
              }));
          }));
      }

      return h('div', { className: 'dpw-root' },
        h('header', null,
          h('h2', { className: 'dpw-title' }, t('提示词精灵', 'Prompt Wisp')),
          h('p', { className: 'dpw-sub' },
            t('本插件全部功能的集中配置。改动保存后立即生效。',
              'Every plugin feature, configured in one place. Changes apply right after saving.'))),

        error !== null ? h('p', { className: 'dpw-note', 'data-kind': 'error' }, error) : null,
        saved !== null ? h('p', { className: 'dpw-note', 'data-kind': 'ok' }, saved) : null,

        renderGroup(t('提示词优化', 'Prompt optimization'), MODES),
        renderGroup(t('会话执行监控', 'Session execution watch'), WATCH_OPTIONS),

        h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
          h('button', {
            type: 'button',
            className: 'dpw-btn',
            disabled: config === null || busy,
            onClick: function click() { save(); },
          }, busy ? t('保存中…', 'Saving…') : t('保存', 'Save')),
          persisted === false
            ? h('span', { className: 'dpw-hint' },
              t('当前 profile 未持久化配置（只对本次运行生效）', 'config not persisted in this profile (session-only)'))
            : null,
        ));
    }

    /* ----------------------------------------------------------------- plugin */

    const inject = ['slots'];

    /**
     * Register the composer button, the watch banner, and the settings page.
     *
     * All three slots are declared by first-party UI packages; the deferred
     * `ctx.slots.inject` fires whenever each declaration commits, before or
     * after this fiber starts — the same seam discipline dsh-workbuddy-
     * connect's probe control uses. The watch banner lives in
     * `conversation.input.dock` (full-width, in-flow above the composer) so
     * it never overlays the input or the transcript.
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
      ctx.slots.inject('conversation.input.dock', function registerWatch() {
        return ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'prompt-wisp-watch',
          order: 90,
        }, WispWatchBanner);
      });
      ctx.slots.inject('settings.section', function registerSettings() {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'prompt-wisp',
          // After the shipped sections (general 0 … agent-presets 20) and the
          // management plugins (session-vault 62, config-manager ~63).
          order: 64,
          label: function label() { return t('提示词精灵', 'Prompt Wisp'); },
        }, WispSettingsSection);
      });
    }

    exports.apply = apply;
    exports.inject = inject;

    return module.exports;
  },
});
