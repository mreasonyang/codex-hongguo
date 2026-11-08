import test from 'node:test'
import assert from 'node:assert/strict'
import { createCoverPage } from '../src/ui/cover-page.ts'

function host() {
  const document = { createElement: tagName => new Element(tagName) }
  class Element {
    constructor(tagName) { this.tagName = tagName; this.ownerDocument = document }
    children = []; attributes = {}; dataset = {}; textContent = ''; className = ''
    style = { setProperty() {} }
    classList = { add: name => { this.className += ' ' + name } }
    append(...children) { this.children.push(...children) }
    replaceChildren(...children) { this.children = children }
    setAttribute(name, value) { this.attributes[name] = value }
  }
  return new Element('section')
}
function nodes(element) { return [element, ...element.children.flatMap(nodes)] }
function text(element) { return nodes(element).map(node => node.textContent).join('\n') }

for (const [index, kind] of ['tasks', 'document', 'report', 'minutes'].entries()) {
  for (const locale of ['zh-CN', 'en-US']) test(`${kind} renders complete local content in ${locale} and remains stable until explicitly changed`, () => {
    const root = host(), page = createCoverPage(root, () => (index + 0.1) / 4)
    page.initialize(locale)
    const rendered = root.children[0], content = text(root), all = nodes(root)
    assert.equal(rendered.dataset.template, kind)
    assert.ok(all.find(node => node.tagName === 'h1')?.textContent.length)
    assert.ok(all.filter(node => node.tagName === 'h2').length >= (kind === 'report' ? 0 : 2))
    assert.ok(content.length > 150)
    assert.equal(all.some(node => ['iframe', 'script', 'img', 'a', 'input'].includes(node.tagName)), false)
    if (locale.startsWith('en')) assert.doesNotMatch(content, /[\u3400-\u9fff]/)
    else assert.match(content, /[\u3400-\u9fff]/)
    if (kind === 'report') {
      const values = all.filter(node => node.tagName === 'dd').map(node => Number(node.textContent))
      assert.equal(values[0], values.slice(1).reduce((a, b) => a + b, 0))
    }
    page.initialize(locale)
    assert.equal(root.children[0], rendered)
    assert.equal(text(root), content)
    page.change()
    assert.notEqual(root.children[0].dataset.template, kind)
    assert.equal(locale.startsWith('en') ? /[\u3400-\u9fff]/.test(text(root)) : false, false)
  })
}
test('separate mounted players get independent pages and layout variations', () => {
  const pages = new Set(), variants = new Set()
  for (let seed = 1; seed <= 48; seed++) {
    let value = seed * 7919
    const random = () => { value = (1664525 * value + 1013904223) >>> 0; return value / 2 ** 32 }
    const root = host(), page = createCoverPage(root, random)
    page.initialize('en')
    pages.add(text(root))
    variants.add(root.children[0].dataset.template)
  }
  assert.equal(variants.size, 4)
  assert.ok(pages.size > 40)
})
