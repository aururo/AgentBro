window.__ModuleLoader__.load({
  id: 'dsh-desktop-client-ui',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { MenuItemButton, Tooltip } = require('@deepseek-ai/dsh-client-ui-primitives')
    // AgentBro wordmark: "AgentBro" converted to outlines by
    // scripts/generate-wordmark.mjs (Inter SemiBold, SIL OFL 1.1). The upstream
    // `BrandWordmark` is a hard-coded "DeepSeek" glyph path that cannot be
    // re-labelled, so the wordmark is inlined here instead.
    // Geometry matches upstream: 24-unit box, cap height 14, baseline 18.6.
    const BRAND_WORDMARK_VIEWBOX = { x: 0, y: 0, width: 84.7, height: 24 }
    const BRAND_WORDMARK_PATH = "M0 18.6L4.89 4.6L8.07 4.6L13.07 18.6L10.32 18.6L7.83 11.33Q7.46 10.2 7.07 8.78Q6.67 7.35 6.19 5.54L6.72 5.54Q6.25 7.37 5.87 8.8Q5.49 10.24 5.15 11.33L2.74 18.6ZM2.85 15.13L2.85 13.11L10.22 13.11L10.22 15.13ZM18.87 22.75Q17.61 22.75 16.68 22.43Q15.74 22.11 15.15 21.56Q14.55 21.01 14.29 20.32L16.35 19.58Q16.52 19.87 16.82 20.18Q17.11 20.49 17.61 20.69Q18.1 20.89 18.86 20.89Q20 20.89 20.69 20.36Q21.37 19.83 21.37 18.7L21.37 16.72L21.16 16.72Q20.99 17.1 20.64 17.5Q20.29 17.9 19.7 18.17Q19.12 18.44 18.2 18.44Q17 18.44 16.02 17.87Q15.04 17.3 14.46 16.17Q13.88 15.03 13.88 13.32Q13.88 11.59 14.47 10.4Q15.05 9.2 16.03 8.58Q17.01 7.96 18.22 7.96Q19.15 7.96 19.76 8.27Q20.36 8.58 20.71 9.02Q21.07 9.46 21.26 9.83L21.39 9.83L21.39 8.1L23.79 8.1L23.79 18.63Q23.79 20.03 23.15 20.94Q22.51 21.86 21.4 22.31Q20.29 22.75 18.87 22.75ZM18.89 16.51Q19.69 16.51 20.24 16.13Q20.8 15.75 21.09 15.03Q21.38 14.31 21.38 13.3Q21.38 12.3 21.09 11.56Q20.81 10.81 20.25 10.39Q19.7 9.97 18.89 9.97Q18.06 9.97 17.5 10.41Q16.95 10.85 16.66 11.6Q16.38 12.34 16.38 13.3Q16.38 14.27 16.67 14.99Q16.96 15.72 17.51 16.11Q18.07 16.51 18.89 16.51ZM30.83 18.82Q29.24 18.82 28.1 18.15Q26.96 17.48 26.34 16.27Q25.73 15.06 25.73 13.41Q25.73 11.79 26.33 10.57Q26.94 9.34 28.05 8.65Q29.17 7.96 30.67 7.96Q31.63 7.96 32.5 8.27Q33.37 8.58 34.04 9.23Q34.71 9.88 35.09 10.88Q35.47 11.88 35.47 13.26L35.47 14.03L26.88 14.03L26.88 12.37L34.26 12.37L33.11 12.86Q33.11 11.98 32.84 11.3Q32.57 10.63 32.03 10.26Q31.49 9.88 30.68 9.88Q29.87 9.88 29.31 10.26Q28.74 10.64 28.45 11.28Q28.15 11.91 28.15 12.69L28.15 13.84Q28.15 14.83 28.49 15.52Q28.83 16.2 29.44 16.55Q30.05 16.9 30.86 16.9Q31.39 16.9 31.83 16.74Q32.27 16.59 32.59 16.28Q32.91 15.98 33.06 15.54L35.31 16Q35.06 16.84 34.45 17.48Q33.84 18.11 32.92 18.46Q32 18.82 30.83 18.82ZM39.82 12.45L39.82 18.6L37.37 18.6L37.37 8.1L39.68 8.1L39.72 10.69L39.52 10.69Q39.97 9.33 40.82 8.64Q41.68 7.96 42.96 7.96Q44.04 7.96 44.85 8.42Q45.66 8.88 46.11 9.77Q46.55 10.65 46.55 11.92L46.55 18.6L44.11 18.6L44.11 12.3Q44.11 11.24 43.56 10.64Q43.02 10.04 42.06 10.04Q41.41 10.04 40.91 10.32Q40.4 10.6 40.11 11.14Q39.82 11.68 39.82 12.45ZM53.81 8.1L53.81 10.01L47.85 10.01L47.85 8.1ZM49.34 5.6L51.78 5.6L51.78 15.64Q51.78 16.21 52.03 16.48Q52.27 16.75 52.82 16.75Q52.99 16.75 53.27 16.71Q53.55 16.66 53.72 16.63L54.1 18.52Q53.7 18.64 53.28 18.69Q52.85 18.74 52.47 18.74Q50.96 18.74 50.15 17.99Q49.34 17.24 49.34 15.85ZM55.7 18.6L55.7 4.6L61.06 4.6Q62.57 4.6 63.58 5.08Q64.58 5.56 65.08 6.38Q65.58 7.19 65.58 8.24Q65.58 9.09 65.25 9.7Q64.92 10.3 64.37 10.68Q63.82 11.06 63.14 11.21L63.14 11.36Q63.88 11.39 64.57 11.81Q65.25 12.22 65.69 12.97Q66.13 13.72 66.13 14.79Q66.13 15.88 65.6 16.74Q65.07 17.6 64.02 18.1Q62.96 18.6 61.35 18.6ZM58.21 16.5L60.96 16.5Q62.35 16.5 62.96 15.97Q63.58 15.43 63.58 14.6Q63.58 13.97 63.27 13.47Q62.96 12.96 62.39 12.67Q61.82 12.38 61.04 12.38L58.21 12.38ZM58.21 10.57L60.74 10.57Q61.41 10.57 61.93 10.32Q62.46 10.08 62.77 9.63Q63.07 9.18 63.07 8.56Q63.07 7.74 62.5 7.21Q61.93 6.69 60.8 6.69L58.21 6.69ZM68.08 18.6L68.08 8.1L70.45 8.1L70.45 9.85L70.56 9.85Q70.85 8.94 71.55 8.45Q72.26 7.95 73.16 7.95Q73.36 7.95 73.62 7.97Q73.87 7.99 74.05 8.02L74.05 10.27Q73.9 10.22 73.56 10.18Q73.22 10.14 72.9 10.14Q72.22 10.14 71.68 10.43Q71.14 10.73 70.83 11.24Q70.53 11.75 70.53 12.42L70.53 18.6ZM79.67 18.82Q78.13 18.82 77.01 18.13Q75.88 17.45 75.26 16.24Q74.65 15.02 74.65 13.4Q74.65 11.77 75.26 10.54Q75.88 9.32 77.01 8.64Q78.13 7.96 79.67 7.96Q81.21 7.96 82.33 8.64Q83.46 9.32 84.08 10.54Q84.69 11.77 84.69 13.4Q84.69 15.02 84.08 16.24Q83.46 17.45 82.33 18.13Q81.21 18.82 79.67 18.82ZM79.67 16.83Q80.52 16.83 81.09 16.37Q81.66 15.91 81.93 15.13Q82.21 14.35 82.21 13.39Q82.21 12.43 81.93 11.65Q81.66 10.87 81.09 10.41Q80.52 9.95 79.67 9.95Q78.81 9.95 78.25 10.41Q77.69 10.87 77.41 11.64Q77.14 12.42 77.14 13.39Q77.14 14.35 77.41 15.13Q77.69 15.91 78.25 16.37Q78.81 16.83 79.67 16.83Z"
    // Tight bounds of the mark inside its 1000x1000 source artwork.
    const BRAND_MARK_VIEWBOX = { x: 203, y: 135.5, width: 600.75, height: 729 }
    // AgentBro mark: a robot head with its screen carved out, drawn in
    // currentColor so it follows the sidebar text color in both themes.
    // Single path, seven sub-paths, carved with fill-rule="evenodd".
    const BRAND_MARK_PATH = "M270.5 216.5H437.9A5.4 5.4 0 0 0 432.5 211.1V167.9A32.4 32.4 0 0 1 464.9 135.5H535.1A32.4 32.4 0 0 1 567.5 167.9V211.1A5.4 5.4 0 0 0 572.9 216.5H729.5A67.5 67.5 0 0 1 797 284V608A67.5 67.5 0 0 1 729.5 675.5H270.5A67.5 67.5 0 0 1 203 608V284A67.5 67.5 0 0 1 270.5 216.5ZM284 270.5H716A27 27 0 0 1 743 297.5V594.5A27 27 0 0 1 716 621.5H284A27 27 0 0 1 257 594.5V297.5A27 27 0 0 1 284 270.5ZM456.13 337.7H456.13A43.2 43.2 0 0 1 499.33 380.9V451.1A43.2 43.2 0 0 1 456.13 494.3H456.13A43.2 43.2 0 0 1 412.93 451.1V380.9A43.2 43.2 0 0 1 456.13 337.7ZM624.88 337.7H624.87A43.2 43.2 0 0 1 668.08 380.9V451.1A43.2 43.2 0 0 1 624.87 494.3H624.88A43.2 43.2 0 0 1 581.67 451.1V380.9A43.2 43.2 0 0 1 624.88 337.7ZM392 675.5H608A20.25 20.25 0 0 1 628.25 695.75V830.75A33.75 33.75 0 0 1 594.5 864.5H529.7A10.8 10.8 0 0 1 518.9 853.7V780.8A10.8 10.8 0 0 0 508.1 770H491.9A10.8 10.8 0 0 0 481.1 780.8V853.7A10.8 10.8 0 0 1 470.3 864.5H405.5A33.75 33.75 0 0 1 371.75 830.75V695.75A20.25 20.25 0 0 1 392 675.5ZM292.77 689H292.78A49.28 49.28 0 0 1 342.05 738.28V794.98A49.28 49.28 0 0 1 292.78 844.25H292.77A49.28 49.28 0 0 1 243.5 794.98V738.28A49.28 49.28 0 0 1 292.77 689ZM692.38 689H753.13A50.63 50.63 0 0 1 803.75 739.63V739.63A50.63 50.63 0 0 1 753.13 790.25H692.38A50.63 50.63 0 0 1 641.75 739.63V739.63A50.63 50.63 0 0 1 692.38 689Z"

    function DesktopBrandMark() {
      // The mark is portrait (600.75x729), so it is scaled by height; at the
      // sidebar's 24px slot this reads at the same weight the wide whale did
      // at 17px.
      const height = 20
      return React.createElement(
        'svg',
        {
          width: height * BRAND_MARK_VIEWBOX.width / BRAND_MARK_VIEWBOX.height,
          height,
          viewBox: `${BRAND_MARK_VIEWBOX.x} ${BRAND_MARK_VIEWBOX.y} ${BRAND_MARK_VIEWBOX.width} ${BRAND_MARK_VIEWBOX.height}`,
          fill: 'none',
          'aria-hidden': 'true'
        },
        React.createElement('path', { d: BRAND_MARK_PATH, fill: 'currentColor', fillRule: 'evenodd' })
      )
    }

    function DesktopBrandName() {
      // Rendered at the upstream wordmark's own box height (24), so the cap
      // height stays at 14px next to the 20px mark.
      const height = 24
      return React.createElement(
        'svg',
        {
          width: height * BRAND_WORDMARK_VIEWBOX.width / BRAND_WORDMARK_VIEWBOX.height,
          height,
          viewBox: `${BRAND_WORDMARK_VIEWBOX.x} ${BRAND_WORDMARK_VIEWBOX.y} ${BRAND_WORDMARK_VIEWBOX.width} ${BRAND_WORDMARK_VIEWBOX.height}`,
          fill: 'none',
          'aria-hidden': 'true'
        },
        React.createElement('path', { d: BRAND_WORDMARK_PATH, fill: 'currentColor' })
      )
    }

    /**
     * Conversation empty-state hero. The seat passes `size`, which the previous
     * whale logo also treated as its box height; the mark is fitted inside that
     * box by height so a portrait mark cannot overflow it.
     */
    function ConversationBrandMark(props) {
      const size = typeof props.size === 'number' ? props.size : 48
      const svgProps = Object.assign({}, props)
      delete svgProps.size
      return React.createElement(
        'svg',
        Object.assign(svgProps, {
          width: size * BRAND_MARK_VIEWBOX.width / BRAND_MARK_VIEWBOX.height,
          height: size,
          viewBox: `${BRAND_MARK_VIEWBOX.x} ${BRAND_MARK_VIEWBOX.y} ${BRAND_MARK_VIEWBOX.width} ${BRAND_MARK_VIEWBOX.height}`,
          fill: 'none',
          'aria-hidden': 'true'
        }),
        React.createElement('path', { d: BRAND_MARK_PATH, fill: 'currentColor', fillRule: 'evenodd' })
      )
    }

    function OpenUnpreviewableFile({ absolutePath, openWorkspacePath }) {
      const [error, setError] = React.useState('')
      const label = document.documentElement.lang?.toLowerCase().startsWith('zh')
        ? '用本地应用打开'
        : 'Open with local app'
      return React.createElement(
        React.Fragment,
        null,
        React.createElement('button', {
          type: 'button',
          'data-textpreview-open-local': true,
          onClick: () => {
            setError('')
            void openWorkspacePath(absolutePath).catch((reason) => {
              setError(reason instanceof Error ? reason.message : String(reason))
            })
          }
        }, label),
        error && React.createElement('span', { role: 'alert' }, error)
      )
    }

    function DeleteSessionMenuItem({ sessionId, displayTitle, useMenuOpenState, deleteSession }) {
      const [, setMenuOpen] = useMenuOpenState()
      const chinese = document.documentElement.lang?.toLowerCase().startsWith('zh')
      const label = chinese ? '永久删除会话' : 'Delete session permanently'
      const warning = chinese
        ? `确定删除“${displayTitle || sessionId}”？工作区文件会保留。此操作无法撤销。`
        : `Delete “${displayTitle || sessionId}”? Workspace files are kept. This can’t be undone.`
      return React.createElement(MenuItemButton, {
        danger: true,
        onSelect: () => {
          setMenuOpen(false)
          if (!window.confirm(warning)) return
          void Promise.resolve().then(() => deleteSession(sessionId)).catch((reason) => {
            window.alert(reason instanceof Error ? reason.message : String(reason))
          })
        }
      }, label)
    }

    function OpenSessionFolderMenuItem({ sessionId, useMenuOpenState, openInFinder }) {
      const [, setMenuOpen] = useMenuOpenState()
      if (typeof window.dshDesktop?.openInFinder !== 'function') return null
      const chinese = document.documentElement.lang?.toLowerCase().startsWith('zh')
      const label = chinese ? '在文件管理器中打开' : 'Open in file manager'
      return React.createElement(MenuItemButton, {
        onSelect: () => {
          setMenuOpen(false)
          void Promise.resolve().then(() => openInFinder(sessionId)).catch((reason) => {
            window.alert(reason instanceof Error ? reason.message : String(reason))
          })
        }
      }, label)
    }

    function UnreadSessionMenuItem({ sessionId, unread, onUnreadChange, useMenuOpenState }) {
      const [, setMenuOpen] = useMenuOpenState()
      const chinese = document.documentElement.lang?.toLowerCase().startsWith('zh')
      return React.createElement(MenuItemButton, {
        onSelect: () => {
          setMenuOpen(false)
          onUnreadChange(sessionId, !unread)
        }
      }, unread ? (chinese ? '标为已读' : 'Mark as read') : (chinese ? '标为未读' : 'Mark as unread'))
    }

    const ENTERPRISE_NS = 'dsh-desktop-enterprise-entry'
    function EnterpriseEntry({ t }) {
      return React.createElement('a', {
        href: 'https://dshdesktop.com/zh/enterprise/', target: '_blank', rel: 'noopener noreferrer',
        'data-dsh-enterprise-entry': true
      }, t('learnMore'), React.createElement('span', { 'aria-hidden': true }, ' ↗'))
    }

    const REPAIR_NS = 'dsh-desktop-repair'
    function DesktopUtilityActions({ t, wide }) {
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [connected, setConnected] = React.useState(false)
      const mounted = React.useRef(true)
      React.useEffect(() => {
        mounted.current = true
        const bridge = window.dshDesktop
        const unsubscribe = bridge?.onMobileStatus?.(status => {
          if (mounted.current) setConnected(status.connected === true)
        })
        void bridge?.getMobileStatus?.().then(status => {
          if (mounted.current) setConnected(status.connected === true)
        }).catch(reason => { if (mounted.current) setError(t('phoneFailed')) })
        return () => { mounted.current = false; unsubscribe?.() }
      }, [t])
      const bridge = window.dshDesktop
      if (!bridge) return null
      const open = async (operation) => {
        if (busy) return
        setBusy(true); setError('')
        try {
          const result = await operation()
          if (result?.ok === false) throw new Error(result.error || t('failed'))
        } catch (reason) {
          if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason))
        } finally { if (mounted.current) setBusy(false) }
      }
      const icon = (kind) => React.createElement('svg', {
        width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true
      }, kind === 'phone'
        ? React.createElement(React.Fragment, null,
          React.createElement('rect', { x: 7, y: 2.75, width: 10, height: 18.5, rx: 2.25 }),
          React.createElement('path', { d: 'M10.2 5.5h3.6M10.5 18.35h3' }))
        : React.createElement('path', { d: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-7.91 7.91a2.12 2.12 0 0 1-3-3l7.91-7.91a6 6 0 0 1 7.94-7.94z' }))
      return React.createElement('div', { 'data-dsh-desktop-utilities': true, 'data-wide': wide },
        typeof bridge.openRepairAgent === 'function' && React.createElement(Tooltip, {
          label: t(busy ? 'opening' : 'description'), side: 'top', align: 'end',
          portal: true, maxWidth: 280, delayMs: 0, focusDelayMs: 0
        }, React.createElement('button', {
          type: 'button', disabled: busy,
          'aria-label': t(busy ? 'opening' : 'open'), 'aria-description': t('description'), 'data-dsh-repair-entry': true,
          onClick: () => { void open(() => bridge.openRepairAgent()) }
        }, icon('repair'))),
        typeof bridge.openMobilePairing === 'function' && (wide || connected) && React.createElement('button', {
          type: 'button', disabled: busy, title: t(connected ? 'phoneManage' : 'phone'),
          'aria-label': t(connected ? 'phoneManage' : 'phone'), 'data-dsh-mobile-entry': true,
          onClick: () => { void open(() => bridge.openMobilePairing()) }
        }, icon('phone'), connected && React.createElement('span', { 'data-connected': true, 'aria-hidden': true })),
        error && React.createElement('span', { role: 'alert', 'data-dsh-utility-error': true }, error))
    }

    // The session-scope slot supplies Harness's public editor actions. Capture the
    // revision before IPC so an async suggestion can never overwrite a user's edit.
    function RepairDraft({ session, input, inputActions }) {
      const currentInput = React.useRef(input)
      currentInput.current = input
      React.useEffect(() => {
        const bridge = window.dshDesktop
        if (typeof bridge?.getRepairDraft !== 'function') return
        let live = true
        const sessionId = session.sessionId
        const span = inputActions.captureInsertion()
        const empty = input.draft === '' && input.attachmentIds.length === 0 && input.phase === 'plain'
        void bridge.getRepairDraft(sessionId).then(async draft => {
          if (!live || typeof draft?.token !== 'string') return
          const current = currentInput.current
          if (empty && current.draft === '' && current.attachmentIds.length === 0 && current.phase === 'plain' && typeof draft.text === 'string' && draft.text !== '') {
            if (inputActions.insertText(draft.text, span)) inputActions.persistDraft()
          }
          // Preserved user input consumes the initial suggestion too; clearing it
          // later must not unexpectedly restore a repair prompt.
          await bridge.acknowledgeRepairDraft(sessionId, draft.token)
        }).catch(reason => { console.warn('[repair] unable to initialize draft', reason) })
        return () => { live = false }
      }, [session.sessionId, inputActions])
      return null
    }

    const inject = ['locale', 'slots', 'remote.session', 'sessions', 'uiWorkspace']
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(ENTERPRISE_NS, {
        zh: { learnMore: '了解企业版' }, en: { learnMore: 'Explore Enterprise' }
      }))
      const enterpriseText = ctx.locale.bind(ENTERPRISE_NS)
      ctx.slots.inject('settings.sidebar.footer', () => ctx.slots.register({
        name: 'settings.sidebar.footer', id: 'desktop-enterprise-entry', locale: ENTERPRISE_NS,
        inject: () => ({ t: enterpriseText })
      }, EnterpriseEntry))
      ctx.effect(() => ctx.locale.register(REPAIR_NS, {
        zh: { open: '进入维修模式', description: '维修 Agent：协助排查和修复问题。点击进入修复模式，描述问题后发送。', opening: '正在打开维修…', failed: '无法打开维修会话，请重试', phone: '连接手机', phoneManage: '管理手机连接', phoneFailed: '无法读取手机连接状态' },
        en: { open: 'Enter repair mode', description: 'Repair Agent helps diagnose and resolve problems. Click to enter repair mode, describe the issue, and send when ready.', opening: 'Opening repair…', failed: 'Could not open repair. Please retry.', phone: 'Connect phone', phoneManage: 'Manage phone connection', phoneFailed: 'Could not read phone connection status.' }
      }))
      const repairText = ctx.locale.bind(REPAIR_NS)
      ctx.slots.inject('sidebar.settings.action', () => ctx.slots.register({
        name: 'sidebar.settings.action', id: 'desktop-utilities', locale: REPAIR_NS,
        inject: () => ({ t: repairText })
      }, DesktopUtilityActions))
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock', id: 'desktop-repair-draft'
      }, RepairDraft))
      ctx.effect(() => {
        const id = 'dsh-desktop-preset-toolbar-style'
        if (document.getElementById(id)) return
        const style = document.createElement('style')
        style.id = id
        style.textContent = `
          [data-dsh-enterprise-entry] {
            display:flex; align-items:center; gap:4px; min-height:36px; padding:0 12px;
            border-radius:8px; color:var(--dsw-alias-label-secondary); font-size:13px;
            line-height:20px; text-decoration:none;
          }
          [data-dsh-enterprise-entry]:hover { color:var(--dsw-alias-label-primary); background:var(--dsw-alias-interactive-bg-hover); }
          [data-dsh-enterprise-entry]:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:1px; }
          :root { --dsh-page-title-top-spacing:56px; }
          [data-dsh-sidebar-settings] { display:flex; align-items:center; }
          [data-dsh-sidebar-settings-content] { flex:1; min-width:0; }
          [data-dsh-sidebar-settings-actions] { flex:none; display:flex; align-items:center; }
          [data-dsh-desktop-utilities] { display:flex; align-items:center; flex:none; position:relative; }
          [data-dsh-desktop-utilities][data-wide=false] { flex-direction:column; }
          [data-dsh-desktop-utilities] button {
            appearance:none; display:inline-flex; align-items:center; justify-content:center;
            width:32px; height:36px; padding:0; position:relative; border:0; border-radius:8px;
            color:var(--dsw-alias-label-secondary); background:transparent; cursor:pointer;
          }
          [data-dsh-desktop-utilities] button > svg { display:block; flex:none; }
          [data-dsh-desktop-utilities] button:hover { background:var(--dsw-alias-interactive-bg-hover); color:var(--dsw-alias-label-primary); }
          [data-dsh-desktop-utilities] button:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:1px; }
          [data-dsh-desktop-utilities] button:disabled { opacity:.5; cursor:wait; }
          [data-dsh-desktop-utilities] [data-connected] { position:absolute; top:7px; right:5px; width:6px; height:6px; border-radius:50%; background:var(--dsw-alias-state-success-primary); }
          [data-dsh-utility-error] { position:absolute; right:0; bottom:100%; width:200px; padding:8px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-state-error-primary); border-radius:8px; }
          [data-dsh-sidebar-root][data-dsh-sidebar-wide=false] [data-dsh-sidebar-settings] { flex-direction:column; }

          /* Top-level page titles align with the sidebar brand row. Keep
             conversation chrome and detail/dialog headers in their own layout. */
          [data-plugin-panel] > header[data-window-drag] {
            padding-top:var(--dsh-page-title-top-spacing);
          }
          [data-dsh-preset-heading] { display:flex; align-items:center; flex-wrap:wrap; gap:12px 16px; }
          [data-dsh-preset-heading] h2 { margin:0; }
          [data-dsh-preset-actions] { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-left:auto; }
          [data-dsh-preset-actions] button { white-space:nowrap; }
          [data-dsh-preset-search] { margin-bottom:16px; }
          [data-dsh-preset-search] input[type=search] {
            box-sizing:border-box; width:100%; min-width:0; height:36px;
            border:1px solid var(--dsw-alias-border-l2); border-radius:10px;
            background:var(--dsw-alias-bg-module-platform); color:var(--dsw-alias-label-primary);
            padding:0 12px; font:inherit; font-size:13px;
          }
          [data-dsh-preset-search] input[type=search]::placeholder { color:var(--dsw-alias-label-caption); }
          [data-dsh-preset-search] input[type=search]:focus-visible {
            outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:2px;
            background:var(--dsw-alias-bg-base);
          }
        `
        document.head.appendChild(style)
        return () => style.remove()
      })
      ctx.slots.inject('sidebar.brand.mark', () =>
        ctx.slots.inject('sidebar.brand.name', () =>
          ctx.slots.inject('conversation.hero.brand.mark', function* () {
            yield ctx.slots.register({ name: 'sidebar.brand.mark' }, DesktopBrandMark)
            yield ctx.slots.register({ name: 'sidebar.brand.name' }, DesktopBrandName)
            yield ctx.slots.register(
              { name: 'conversation.hero.brand.mark' },
              ConversationBrandMark
            )
          })
        )
      )
      ctx.slots.inject('sidebar.right.tab.document.unpreviewable', () =>
        ctx.slots.register({
          name: 'sidebar.right.tab.document.unpreviewable',
          id: 'desktop-open-local',
          inject: () => ({
            openWorkspacePath: (path) => ctx.remote.session.openWorkspacePath({ path })
          })
        }, OpenUnpreviewableFile)
      )
      ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
        ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'desktop-delete-session',
          order: 900,
          inject: () => ({
            deleteSession: (sessionId) => {
              const workspace = ctx.get('uiWorkspace')
              if (!workspace) throw new Error('Workspace navigation is unavailable')
              return workspace.deleteSession(sessionId)
            }
          })
        }, DeleteSessionMenuItem)
      )
      ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
        ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'desktop-open-session-folder',
          order: 800,
          inject: () => ({
            openInFinder: (sessionId) => {
              const cwd = ctx.get('sessions').list.getSnapshot().byId[sessionId]?.cwd
              if (!cwd) throw new Error('Session workspace directory is unavailable')
              return window.dshDesktop.openInFinder(cwd)
            }
          })
        }, OpenSessionFolderMenuItem)
      )
      ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
        ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'desktop-unread-session',
          order: 350
        }, UnreadSessionMenuItem)
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
