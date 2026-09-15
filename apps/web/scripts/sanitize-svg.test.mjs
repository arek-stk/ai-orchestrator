import { describe, expect, it } from 'vitest';
import { sanitizeSvg } from './sanitize-svg.mjs';

describe('sanitizeSvg', () => {
  it('keeps the viewBox, title and path data of a Simple Icons style file', () => {
    const input = '<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>Example</title><path d="M0 0h24v24H0z"/></svg>';
    expect(sanitizeSvg(input)).toBe('<svg xmlns="http://www.w3.org/2000/svg" role="img" viewBox="0 0 24 24"><title>Example</title><path d="M0 0h24v24H0z"/></svg>\n');
  });

  it('sets the fill colour on the root and validates it', () => {
    const output = sanitizeSvg('<svg viewBox="0 0 1 1" fill="red"><path d="M0 0"/></svg>', { fill: '#D97757' });
    expect(output).toContain('fill="#D97757"');
    expect(output).not.toContain('red');
    expect(() => sanitizeSvg('<svg viewBox="0 0 1 1"></svg>', { fill: 'url(#x)' })).toThrow();
  });

  it('removes scripts, event handlers, foreignObject, styles and external references', () => {
    const input = [
      '<?xml version="1.0"?><!DOCTYPE svg><!-- comment -->',
      '<svg viewBox="0 0 10 10" onload="alert(1)" width="10">',
      '<script>alert(1)</script>',
      '<style>path{fill:url(https://evil.example/x)}</style>',
      '<foreignObject><div onclick="x()">hi</div></foreignObject>',
      '<use href="https://evil.example/sprite.svg#a"/>',
      '<image xlink:href="data:image/png;base64,AAAA"/>',
      '<g onclick="steal()" fill="url(#grad)" transform="translate(1 1)"><path d="M1 1" onmouseover="x()"/></g>',
      '<a href="javascript:alert(1)"><path d="M2 2"/></a>',
      '</svg>',
    ].join('');
    const output = sanitizeSvg(input);
    expect(output).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g transform="translate(1 1)"><path d="M1 1"/></g></svg>\n');
  });

  it('escapes title text and rejects input without an svg root or viewBox', () => {
    expect(sanitizeSvg('<svg viewBox="0 0 1 1"><title>A &amp; B</title></svg>')).toContain('<title>A &amp;amp; B</title>');
    expect(() => sanitizeSvg('<path d="M0 0"/>')).toThrow();
    expect(() => sanitizeSvg('<svg><path d="M0 0"/></svg>')).toThrow();
  });

  it('handles quotes containing ">" and unterminated input in linear time', () => {
    expect(sanitizeSvg('<svg viewBox="0 0 1 1"><path d="M0 0" data-x="a>b"/></svg>')).toContain('<path d="M0 0"/>');
    const hostile = `<svg viewBox="0 0 1 1">${'<g '.repeat(20_000)}`;
    const started = Date.now();
    expect(() => sanitizeSvg(hostile)).not.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
