// oh-my-dsh — browser half: the "oh my dsh" settings tab.
//
// Served at /plugins/oh-my-dsh/client.js by the client-modules system and
// composed into the Web shell. Registers one `settings.section` slot entry:
// a tab with pickers for the think/build tiers, the vision model used for
// image messages, and the image-generation model. Data flows through the
// /omd endpoint the host half serves (the settings RPC does not expose
// third-party namespaces).
//
// Plain JavaScript on purpose: the bundle is served verbatim and evaluated by
// the shell kernel — no JSX, no TypeScript.

window.__ModuleLoader__.load({
  id: 'oh-my-dsh',
  factory: (require) => {
    const React = require('react')
    const { useState, useEffect, useRef } = React
    const e = React.createElement

    const C = {
      section: { maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 14, color: 'var(--dsw-alias-label-primary)' },
      title: { margin: 0, fontSize: 16, fontWeight: 500, lineHeight: '24px' },
      intro: { color: 'var(--dsw-alias-label-tertiary)', margin: 0, fontSize: 13, lineHeight: '20px' },
      card: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12, background: 'var(--dsw-alias-bg-layer-1)' },
      cardTitle: { margin: 0, fontSize: 14, fontWeight: 600, lineHeight: '22px' },
      cardDesc: { color: 'var(--dsw-alias-label-tertiary)', margin: 0, fontSize: 12, lineHeight: '18px' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 },
      field: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
      label: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, fontWeight: 500, lineHeight: '18px' },
      input: {
        boxSizing: 'border-box', border: '1px solid var(--dsw-alias-border-l2)', width: '100%', height: 32,
        font: 'inherit', background: 'var(--dsw-alias-bg-module-platform)', color: 'var(--dsw-alias-label-primary)',
        borderRadius: 8, padding: '0 10px', fontSize: 13, lineHeight: '20px',
      },
      checkboxRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)' },
      actions: { display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'flex-end' },
      button: {
        boxSizing: 'border-box', height: 34, font: 'inherit', cursor: 'pointer', border: 'none', borderRadius: 17,
        padding: '0 16px', fontSize: 13, lineHeight: '20px',
        background: 'var(--dsw-alias-button-primary-fill)', color: 'var(--dsw-alias-label-primary-foreground)',
      },
      saved: { color: 'var(--dsw-alias-state-success-primary)', margin: 0, fontSize: 12, lineHeight: '18px' },
      error: { color: 'var(--dsw-alias-state-error-primary)', margin: 0, fontSize: 12, lineHeight: '18px' },
      tag: { border: '1px solid var(--dsw-alias-border-l3)', color: 'var(--dsw-alias-label-secondary)', borderRadius: 4, padding: '1px 6px', fontSize: 11, lineHeight: '16px' },
    }

    const EFFORTS = ['off', 'high', 'max']
    const MODES = [['auto', 'auto — think in plan mode, build while executing'], ['strong', 'strong — always the think tier'], ['cheap', 'cheap — always the build tier'], ['off', 'off — routing disabled']]
    const POLICIES = ['inherit', 'cheap', 'strong']

    function Field(props) {
      const { label, children } = props
      return e('div', { style: C.field },
        e('label', { style: C.label }, label),
        children,
      )
    }

    function Card(props) {
      const { title, desc, children } = props
      return e('section', { style: C.card },
        e('h3', { style: C.cardTitle }, title),
        desc ? e('p', { style: C.cardDesc }, desc) : null,
        children,
      )
    }

    function CollapsibleCard(props) {
      const { title, desc, children, defaultOpen } = props
      const [open, setOpen] = useState(!!defaultOpen)
      const chevron = e('span', {
        style: {
          display: 'inline-block',
          marginLeft: 'auto',
          transition: 'transform .15s ease',
          transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
          color: 'var(--dsw-alias-label-tertiary)',
        },
      }, '›')
      return e('section', { style: C.card },
        e('button', {
          type: 'button',
          onClick: () => setOpen(!open),
          style: {
            display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: 0, margin: 0,
            background: 'none', border: 'none', cursor: 'pointer', font: 'inherit', textAlign: 'left',
          },
        },
          e('h3', { style: { ...C.cardTitle, margin: 0 } }, title),
          chevron,
        ),
        desc ? e('p', { style: C.cardDesc }, desc) : null,
        open ? e('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, marginTop: 8 } }, children) : null,
      )
    }

    function selectProps(value, onChange) {
      return {
        style: C.input,
        value: value ?? '',
        onChange: (ev) => onChange(ev.target.value),
      }
    }

    function ModelPick(props) {
      const { cfg, view, fieldPrefix, effort, onSet } = props
      const provider = cfg[fieldPrefix + 'Provider'] ?? ''
      const model = cfg[fieldPrefix + 'Model'] ?? ''
      const providers = view && Array.isArray(view.providers) ? view.providers : []
      const modelList = (view && view.models && view.models[provider]) || []
      const providerOptions = providers.map((p) => e('option', { key: p.id, value: p.id }, p.name || p.id))
      const modelOptions = modelList.map((m) => e('option', { key: m.id, value: m.id }, (m.name || m.id) + (m.inputModalities && m.inputModalities.indexOf('image') !== -1 ? ' (vision)' : '')))
      return e(React.Fragment, null,
        e('div', { style: C.grid },
          e(Field, { label: 'Provider' },
            e('select', selectProps(provider, (v) => { onSet(fieldPrefix + 'Provider', v); onSet(fieldPrefix + 'Model', '') }),
              providerOptions.length > 0 ? providerOptions : e('option', { value: '' }, 'none registered'),
            ),
          ),
          e(Field, { label: 'Model' },
            e('select', selectProps(model, (v) => onSet(fieldPrefix + 'Model', v)),
              modelOptions.length > 0 ? modelOptions : e('option', { value: model }, model || 'pick a provider first'),
            ),
          ),
          effort
            ? e(Field, { label: 'Reasoning effort' },
              e('select', selectProps(cfg[effort], (v) => onSet(effort, v)),
                EFFORTS.map((x) => e('option', { key: x, value: x }, x)),
              ),
            )
            : null,
        ),
      )
    }

    function VisionPick(props) {
      const { cfg, view, onSet } = props
      const provider = cfg.visionProvider ?? ''
      const model = cfg.visionModel ?? ''
      const visionModels = (view && view.visionModels) || []
      const providerSet = []
      for (const vm of visionModels) if (providerSet.indexOf(vm.provider) === -1) providerSet.push(vm.provider)
      const modelsFor = visionModels.filter((vm) => vm.provider === provider)
      return e('div', { style: C.grid },
        e(Field, { label: 'Provider' },
          e('select', selectProps(provider, (v) => { onSet('visionProvider', v); onSet('visionModel', '') }),
            providerSet.length > 0
              ? providerSet.map((p) => e('option', { key: p, value: p }, p))
              : e('option', { value: '' }, 'no vision-capable models found'),
          ),
        ),
        e(Field, { label: 'Vision model' },
          e('select', selectProps(model, (v) => onSet('visionModel', v)),
            modelsFor.length > 0
              ? modelsFor.map((m) => e('option', { key: m.id, value: m.id }, m.name || m.id))
              : e('option', { value: model }, model || 'pick a provider first'),
          ),
        ),
      )
    }

    function OhMyDshSection() {
      const [view, setView] = useState(null)
      const [draft, setDraft] = useState(null)
      const [loadError, setLoadError] = useState('')
      const [saving, setSaving] = useState(false)
      const [savedAt, setSavedAt] = useState(0)
      const [saveError, setSaveError] = useState('')
      const mounted = useRef(true)

      useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false }
      }, [])

      useEffect(() => {
        let cancelled = false
        fetch('/omd/config')
          .then((r) => r.json())
          .then((data) => {
            if (cancelled) return
            if (data && data.ok) {
              setView(data)
              setDraft({ ...data.config })
            } else {
              setLoadError((data && data.message) || 'unknown response')
            }
          })
          .catch((err) => {
            if (!cancelled) setLoadError('cannot reach /omd/config — is the oh-my-dsh host half mounted? (' + String(err && err.message || err) + ')')
          })
        return () => { cancelled = true }
      }, [])

      if (loadError) {
        return e('div', { style: C.section },
          e('h2', { style: C.title }, 'oh my dsh'),
          e('p', { style: C.error }, loadError),
        )
      }
      if (!view || !draft) {
        return e('div', { style: C.section },
          e('h2', { style: C.title }, 'oh my dsh'),
          e('p', { style: C.intro }, 'Loading configuration…'),
        )
      }

      const set = (key, value) => {
        // Functional updater: paired calls in one handler (provider + model
        // reset) must compose on the latest state, not a stale render-closure
        // draft — otherwise the second call reverts the first's change.
        setDraft((prev) => ({ ...prev, [key]: value }))
        setSavedAt(0)
        setSaveError('')
      }
      const save = () => {
        if (saving) return
        setSaving(true)
        setSaveError('')
        fetch('/omd/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(draft),
        })
          .then((r) => r.json())
          .then((data) => {
            if (data && data.ok) {
              setDraft({ ...data.config })
              setView({ ...view, config: { ...data.config } })
              setSavedAt(Date.now())
            } else {
              setSaveError((data && data.message) || 'save failed')
            }
          })
          .catch((err) => setSaveError(String(err && err.message || err)))
          .finally(() => { if (mounted.current) setSaving(false) })
      }

      const changed = JSON.stringify(draft) !== JSON.stringify(view.config || {})

      return e('div', { style: C.section },
        e('h2', { style: C.title }, 'oh my dsh'),
        e('p', { style: C.intro }, 'Tiered model routing: a think tier plans and reviews, a build tier implements, a vision tier describes images you paste for models that cannot see them, and an image model generates images. Changes apply to the next step; new sessions use the oh-my-dsh preset.'),
        e(Card, { title: 'Think tier', desc: 'Planning, architecture, hard debugging, reviews.' },
          e(ModelPick, { cfg: draft, view, fieldPrefix: 'strong', effort: 'strongEffort', onSet: set }),
        ),
        e(Card, { title: 'Build tier', desc: 'Day-to-day implementation at a cheaper price.' },
          e(ModelPick, { cfg: draft, view, fieldPrefix: 'cheap', effort: 'cheapEffort', onSet: set }),
        ),
        e(Card, { title: 'Vision tier', desc: 'Image messages are described by this model in the background; the working tier (think/build) answers from the description. The image stays in the chat — the session model never switches for an image.' },
          e(VisionPick, { cfg: draft, view, onSet: set }),
          e('label', { style: C.checkboxRow },
            e('input', { type: 'checkbox', checked: !!draft.visionAuto, onChange: (ev) => set('visionAuto', ev.target.checked) }),
            'Automatically describe images with the vision model (the working tier answers)',
          ),
        ),
        e(CollapsibleCard, {
          title: 'Image generation',
          desc: 'The model used by omd_image and /omd image. Pick a registered provider (e.g. openai-codex) and a model id. The openai-codex provider requires ChatGPT OAuth sign-in (Settings → Plugins → Plugin configuration → Codex Connect → Sign in with ChatGPT) — images are then generated with gpt-image-2 through the Codex backend. Mention the desired size in your prompt, or let the model decide.',
        },
          e('div', { style: C.grid },
            e(Field, { label: 'Provider' },
              e('select', selectProps(draft.imageProvider ?? '', (v) => { set('imageProvider', v); if (v !== '') set('imageModel', v.toLowerCase().indexOf('codex') !== -1 ? 'gpt-5.6-luna' : (draft.imageModel || 'gpt-5.6-luna')) }),
                e('option', { value: '' }, 'custom endpoint (advanced)'),
                (view.imageProviders || []).map((p) => e('option', { key: p.id, value: p.id }, (p.name || p.id) + (p.builtin ? ' (builtin catalog)' : ''))),
              ),
            ),
            e(Field, { label: 'Image model (model id, e.g. gpt-5.6-luna)' },
              e('input', { style: C.input, list: 'omd-image-models', placeholder: 'gpt-5.6-luna', value: draft.imageModel ?? '', onChange: (ev) => set('imageModel', ev.target.value) }),
            ),
            e(Field, { label: 'Output directory (relative to the workspace)' },
              e('input', { style: C.input, value: draft.imageOutDir ?? '', onChange: (ev) => set('imageOutDir', ev.target.value) }),
            ),
          ),
          e('datalist', { id: 'omd-image-models' }, [
            ...new Set([
              'gpt-5.6-luna',
              'gpt-image-1',
              ...(((view.models || {})[draft.imageProvider] || []).map((m) => m.id)),
            ]),
          ].map((s) => e('option', { key: s, value: s }))),
          (draft.imageProvider ?? '') !== ''
            ? e('div', null,
              e('p', { style: C.cardDesc }, 'Route (derived automatically from the provider):'),
              e('p', { style: C.intro },
                (view.imageRoute && view.imageRoute.baseUrl ? view.imageRoute.baseUrl : 'base URL') + ' · api ' + (view.imageRoute && view.imageRoute.api ? view.imageRoute.api : '?') + ' · key: ' + ((view.imageRoute && view.imageRoute.keyConfigured) ? 'configured ✓' : ((view.imageRoute && view.imageRoute.keyEnv) || 'no env var') + ' (not found)') + ' — shows the saved configuration, updates after Save.',
              ),
            )
            : e('div', { style: C.grid },
              e(Field, { label: 'Base URL (custom endpoint)' },
                e('input', { style: C.input, placeholder: 'https://api.openai.com/v1', value: draft.imageBaseUrl ?? '', onChange: (ev) => set('imageBaseUrl', ev.target.value) }),
              ),
              e(Field, { label: 'API key env var' },
                e('input', { style: C.input, placeholder: 'OPENAI_API_KEY', value: draft.imageApiKeyEnv ?? '', onChange: (ev) => set('imageApiKeyEnv', ev.target.value) }),
              ),
              e(Field, { label: 'Inline API key (optional, stored in settings.yaml)' },
                e('input', { style: C.input, type: 'password', placeholder: 'leave empty to use the env var', value: draft.imageApiKey ?? '', onChange: (ev) => set('imageApiKey', ev.target.value) }),
              ),
            ),
          e('label', { style: C.checkboxRow },
            e('input', { type: 'checkbox', checked: !!draft.imageUseModalities, onChange: (ev) => set('imageUseModalities', ev.target.checked) }),
            'Ask for image output (modalities: image+text on chat calls — needed for chat models that generate images)',
          ),
        ),
        e(CollapsibleCard, {
          title: 'Advanced',
          desc: 'How each session picks its model per step: mode, subagent policy, failure escalation, and the high-impact guard.',
        },
          e('div', { style: C.grid },
            e(Field, { label: 'Mode' },
              e('select', selectProps(draft.mode, (v) => set('mode', v)),
                MODES.map(([value, label]) => e('option', { key: value, value }, label)),
              ),
            ),
            e(Field, { label: 'Subagent policy' },
              e('select', selectProps(draft.subagentPolicy, (v) => set('subagentPolicy', v)),
                POLICIES.map((x) => e('option', { key: x, value: x }, x)),
              ),
            ),
          ),
          e('div', { style: C.grid },
            e(Field, { label: 'Escalation: errors' },
              e('input', { type: 'number', min: 1, max: 100, style: C.input, value: draft.escalateThreshold, onChange: (ev) => set('escalateThreshold', Number(ev.target.value)) }),
            ),
            e(Field, { label: 'Escalation: window (s)' },
              e('input', { type: 'number', min: 1, max: 86400, style: C.input, value: draft.escalateWindowSec, onChange: (ev) => set('escalateWindowSec', Number(ev.target.value)) }),
            ),
            e(Field, { label: 'Escalation: strong for (s)' },
              e('input', { type: 'number', min: 1, max: 86400, style: C.input, value: draft.escalateTtlSec, onChange: (ev) => set('escalateTtlSec', Number(ev.target.value)) }),
            ),
          ),
          e('label', { style: C.checkboxRow },
            e('input', { type: 'checkbox', checked: !!draft.guardEnabled, onChange: (ev) => set('guardEnabled', ev.target.checked) }),
            'High-impact guard — deny rm -rf / sudo / force push / secret edits on the build tier',
          ),
        ),
        e('div', { style: C.actions },
          saveError ? e('p', { style: C.error }, saveError) : null,
          savedAt > 0 && !changed ? e('p', { style: C.saved }, 'Saved ✓') : null,
          e('button', { type: 'button', style: C.button, disabled: saving || !changed, onClick: save }, saving ? 'Saving…' : 'Save changes'),
        ),
      )
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'oh-my-dsh',
        order: 50,
        label: () => 'oh my dsh',
        inject: () => ({}),
      }, OhMyDshSection))
    }

    return { name: 'oh-my-dsh', inject: ['slots'], apply }
  },
})
