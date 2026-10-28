window.__ModuleLoader__.load({
  id: '@zumikua/dsh-junie-subagent',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    // Same-origin route registered by this bundle's Host half.
    const ROUTE = '/junie-subagent/config'
    const CUSTOM = '__custom__'
    const EFFORT_LABEL = { low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高' }

    // Inherit the host theme instead of inventing colors: these tokens exist in
    // both light and dark themes, which is what keeps the panel legible.
    const rowStyle = { display: 'flex', alignItems: 'center', gap: '12px', margin: '12px 0' }
    const labelStyle = { width: '120px', color: 'var(--dsw-alias-label-secondary)', flex: '0 0 auto', fontSize: '13px' }
    const controlStyle = {
      minWidth: '300px',
      padding: '6px 8px',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: '8px',
      fontSize: '13px',
      outline: 'none',
    }
    const buttonStyle = {
      ...controlStyle,
      minWidth: '88px',
      width: 'auto',
      cursor: 'pointer',
      color: 'var(--dsw-alias-label-primary)',
    }
    const hintStyle = { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', marginTop: '12px', lineHeight: 1.6 }
    const noteStyle = { fontSize: '12px', marginTop: '8px', color: 'var(--dsw-alias-label-secondary)' }

    function groupOptions(models) {
      const groups = new Map()
      for (const entry of models) {
        const key = entry.group && entry.group.length > 0 ? entry.group : ''
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(entry)
      }
      return [...groups.entries()]
    }

    function JunieSettings() {
      const [model, setModel] = useState('')
      const [effort, setEffort] = useState('high')
      const [models, setModels] = useState([])
      const [custom, setCustom] = useState(false)
      const [loaded, setLoaded] = useState(false)
      const [note, setNote] = useState(null)
      const [busy, setBusy] = useState(false)

      const load = useCallback(async (keepNote = false) => {
        try {
          const response = await fetch(ROUTE, { credentials: 'same-origin', cache: 'no-store' })
          if (!response.ok) {
            setNote(`读取失败：HTTP ${response.status}`)
            return
          }
          const body = await response.json()
          const nextModel = typeof body.model === 'string' ? body.model : 'mix.normal'
          const catalog = Array.isArray(body.models) ? body.models : []
          setModel(nextModel)
          setEffort(typeof body.effort === 'string' ? body.effort : 'high')
          setModels(catalog)
          setCustom(catalog.length === 0 || !catalog.some((entry) => entry.value === nextModel))
          setLoaded(true)
          if (!keepNote) setNote(null)
        } catch (error) {
          setNote(`读取失败：${String(error?.message ?? error)}`)
        }
      }, [])

      useEffect(() => {
        load()
      }, [load])

      const save = useCallback(async () => {
        setBusy(true)
        try {
          const response = await fetch(ROUTE, {
            method: 'PUT',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model, effort }),
          })
          const body = await response.json().catch(() => ({}))
          if (!response.ok) {
            // The refusal already names the values this model accepts; the
            // option list itself stays complete so switching models recovers.
            setNote(body.error ?? `保存失败：HTTP ${response.status}`)
            return
          }
          await load(true)
          setNote('已保存，下一次委派生效')
        } catch (error) {
          setNote(`保存失败：${String(error?.message ?? error)}`)
        } finally {
          setBusy(false)
        }
      }, [model, effort, load])

      if (!loaded) return h('div', { style: hintStyle }, note ?? '正在读取 Junie 配置…')

      const known = models.some((entry) => entry.value === model)
      return h('div', null,
        h('div', { style: rowStyle },
          h('span', { style: labelStyle }, '模型'),
          custom
            ? h('input', {
                style: { ...controlStyle, width: '300px' },
                value: model,
                disabled: busy,
                spellCheck: false,
                placeholder: '例如 mix.normal 或 v1:12:jetbrains-ai:gemini-3.7-flash',
                onChange: (event) => setModel(event.target.value),
              })
            : h('select', {
                style: controlStyle,
                value: known ? model : CUSTOM,
                disabled: busy,
                onChange: (event) => {
                  if (event.target.value === CUSTOM) {
                    setCustom(true)
                    return
                  }
                  setModel(event.target.value)
                },
              },
                models.length === 0 ? h('option', { value: model }, model) : null,
                groupOptions(models).map(([group, entries]) =>
                  group.length > 0
                    ? h('optgroup', { key: group, label: group },
                        entries.map((entry) => h('option', { key: entry.value, value: entry.value }, entry.name)))
                    : entries.map((entry) => h('option', { key: entry.value, value: entry.value }, entry.name))),
                h('option', { value: CUSTOM }, '自定义…')),
          h('button', {
            type: 'button',
            style: buttonStyle,
            disabled: busy,
            onClick: () => setCustom((value) => !value),
          }, custom ? '用列表' : '手动输入')),
        h('div', { style: rowStyle },
          h('span', { style: labelStyle }, '思考深度'),
          h('select', {
            style: controlStyle,
            value: effort,
            disabled: busy,
            onChange: (event) => setEffort(event.target.value),
          }, ['low', 'medium', 'high', 'xhigh', 'max'].map((id) =>
            h('option', { key: id, value: id }, `${EFFORT_LABEL[id] ?? id}（${id}）`)))),
        h('div', { style: rowStyle },
          h('span', { style: labelStyle }, ''),
          h('button', { type: 'button', style: buttonStyle, disabled: busy, onClick: save },
            busy ? '保存中…' : '保存')),
        note === null ? null : h('div', { style: noteStyle }, note),
        h('div', { style: hintStyle },
          '修改后下一次 Junie 委派生效。思考深度的可选项取决于模型，不支持的组合会在保存时提示，不会改动这里的选项。'),
        h('div', { style: hintStyle },
          '模型列表来自 Junie 自己的 ACP 配置项，设置保存在 ~/.dsh/junie-settings.json。'))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'junie',
          order: 40,
          label: () => 'Junie',
        }, JunieSettings)))
      },
    }
  },
})
