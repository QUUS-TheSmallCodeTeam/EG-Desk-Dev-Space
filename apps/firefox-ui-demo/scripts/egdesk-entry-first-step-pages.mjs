// L51: in-memory snapshots of the two real pages (httpbin.org/forms/post, the-internet dynamic_loading/2) shaped like the Card's observation.
const FORM = 'https://httpbin.org/forms/post', POST = 'https://httpbin.org/post'
const FORMNAV = { type: 'submit', sensitiveRegion: false, regionLabel: '', form: { method: 'post', sensitive: false, fields: ['text', 'tel', 'email', 'radio', 'checkbox', 'time', 'text', 'submit'], submitUrl: POST } }
const FORMTEXT = ['Customer name:', 'Telephone:', 'E-mail address:', 'Pizza Size', 'Small', 'Medium', 'Large', 'Pizza Toppings', 'Bacon', 'Extra Cheese', 'Onion', 'Mushroom', 'Preferred delivery time:', 'Delivery instructions:', 'Submit order']
const topping = (n, label) => ({ ref: 't' + n, tag: 'input', role: 'checkbox', type: 'checkbox', label, value: label.toLowerCase(), checked: false, choice: { inForm: true, immediate: false, sensitiveRegion: false, regionLabels: ['Pizza Toppings'] } })
export function formPage(st) {
  const els = [['custname', 'Customer name:', 'textbox', 'text'], ['custtel', 'Telephone:', 'tel', 'tel'], ['custemail', 'E-mail address:', 'email', 'email']].map(([n, label, role, type], i) => ({ ref: 'f' + i, tag: 'input', role: role === 'tel' ? 'textbox' : role, type, label, value: st[n] ?? '' }))
  const radios = ['Small', 'Medium', 'Large'].map((label, i) => ({ ref: 'r' + i, tag: 'input', role: 'radio', type: 'radio', label, value: label.toLowerCase(), checked: false, choice: { inForm: true, immediate: false, sensitiveRegion: false, regionLabels: ['Pizza Size'] } }))
  const tops = ['Bacon', 'Extra Cheese', 'Onion', 'Mushroom'].map((l, i) => ({ ...topping(i, l), checked: !!st.checked[l] }))
  return { url: FORM, revision: st.rev, documentId: 'd', readyState: 'complete', title: 'Order form', text: FORMTEXT, interactiveElements: [...els, ...radios, ...tops,
    { ref: 'tm', tag: 'input', role: 'time', type: 'time', label: 'Preferred delivery time:', value: st.time ?? '' },
    { ref: 'cm', tag: 'textarea', role: 'textbox', type: 'textarea', label: 'Delivery instructions:', value: '' },
    { ref: 'sub', label: 'Submit order', tag: 'button', role: 'button', value: '', nav: FORMNAV }] }
}
const link = (ref, label, href) => ({ ref, tag: 'a', role: 'link', label, href, value: '' })
const EXTRA = [link('g1', 'Fork me on GitHub', 'https://github.com/tourdedave/the-internet'), link('e1', 'Elemental Selenium', 'http://elementalselenium.com/'), link('s1', 'Sauce Labs', 'http://saucelabs.com')]
export function latePage(st) {
  const base = { url: 'https://the-internet.herokuapp.com/dynamic_loading/2', revision: st.rev, documentId: 'd', readyState: 'complete', title: 'The Internet' }
  if (st.phase === 'idle') return { ...base, text: ['The Internet', 'Dynamically Loaded Page Elements', 'Example 2: Element rendered after the fact', 'Start', 'Powered by Elemental Selenium and Sauce Labs'], interactiveElements: [...EXTRA, { ref: 'b1', tag: 'button', role: 'button', label: 'Start', value: '', nav: { standalone: true, form: null, sensitiveRegion: false, regionLabel: '', regionLabels: [] } }] }
  const left = st.phase === 'loading'
  return { ...base, text: left ? ['Dynamically Loaded Page Elements', 'Loading...'] : ['Dynamically Loaded Page Elements', 'Hello World!'], interactiveElements: [...EXTRA] }
}
