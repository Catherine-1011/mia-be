const sanitizeHtml = require('sanitize-html');

const NEWSLETTER_HTML_OPTIONS = Object.freeze({
  allowedTags: [
    'p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 'u',
    'ul', 'ol', 'li', 'div', 'span', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td',
    'th', 'a', 'img', 'blockquote', 'hr'
  ],
  allowedAttributes: {
    '*': ['style', 'align', 'valign', 'title'],
    table: ['width', 'height', 'bgcolor', 'cellpadding', 'cellspacing', 'border'],
    tr: ['align', 'valign', 'bgcolor'],
    td: ['width', 'height', 'align', 'valign', 'bgcolor', 'colspan', 'rowspan'],
    th: ['width', 'height', 'align', 'valign', 'bgcolor', 'colspan', 'rowspan'],
    a: ['href', 'target', 'rel', 'title'],
    img: ['src', 'alt', 'title', 'width', 'height', 'align', 'border']
  },
  allowedSchemes: ['https', 'http', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['https', 'http'], a: ['https', 'http', 'mailto', 'tel'] },
  allowProtocolRelative: false,
  enforceHtmlBoundary: true,
  allowedStyles: {
    '*': {
      color: [/^#[0-9a-f]{3,8}$/i, /^rgba?\([\d\s,.%]+\)$/i, /^[a-z]+$/i],
      'background-color': [/^#[0-9a-f]{3,8}$/i, /^rgba?\([\d\s,.%]+\)$/i, /^[a-z]+$/i],
      'font-family': [/^[a-z0-9 ,"'-]+$/i],
      'font-size': [/^\d+(?:\.\d+)?(?:px|pt|em|rem|%)$/i],
      'font-weight': [/^(?:normal|bold|bolder|lighter|[1-9]00)$/i],
      'font-style': [/^(?:normal|italic|oblique)$/i],
      'line-height': [/^(?:normal|\d+(?:\.\d+)?(?:px|pt|em|rem|%)?)$/i],
      'letter-spacing': [/^-?\d+(?:\.\d+)?(?:px|pt|em|rem)$/i],
      'text-align': [/^(?:left|right|center|justify)$/i],
      'text-decoration': [/^(?:none|underline|line-through)$/i],
      'text-transform': [/^(?:none|capitalize|uppercase|lowercase)$/i],
      display: [/^(?:block|inline|inline-block|table|table-row|table-cell|none)$/i],
      width: [/^(?:auto|\d+(?:\.\d+)?(?:px|em|rem|%)?)$/i],
      'max-width': [/^(?:none|\d+(?:\.\d+)?(?:px|em|rem|%)?)$/i],
      height: [/^(?:auto|\d+(?:\.\d+)?(?:px|em|rem|%)?)$/i],
      'max-height': [/^(?:none|\d+(?:\.\d+)?(?:px|em|rem|%)?)$/i],
      margin: [/^(?:auto|0|-?\d+(?:\.\d+)?(?:px|em|rem|%))(?:\s+(?:auto|0|-?\d+(?:\.\d+)?(?:px|em|rem|%))){0,3}$/i],
      'margin-top': [/^(?:auto|0|-?\d+(?:\.\d+)?(?:px|em|rem|%))$/i],
      'margin-right': [/^(?:auto|0|-?\d+(?:\.\d+)?(?:px|em|rem|%))$/i],
      'margin-bottom': [/^(?:auto|0|-?\d+(?:\.\d+)?(?:px|em|rem|%))$/i],
      'margin-left': [/^(?:auto|0|-?\d+(?:\.\d+)?(?:px|em|rem|%))$/i],
      padding: [/^(?:0|\d+(?:\.\d+)?(?:px|em|rem|%))(?:\s+(?:0|\d+(?:\.\d+)?(?:px|em|rem|%))){0,3}$/i],
      'padding-top': [/^(?:0|\d+(?:\.\d+)?(?:px|em|rem|%))$/i],
      'padding-right': [/^(?:0|\d+(?:\.\d+)?(?:px|em|rem|%))$/i],
      'padding-bottom': [/^(?:0|\d+(?:\.\d+)?(?:px|em|rem|%))$/i],
      'padding-left': [/^(?:0|\d+(?:\.\d+)?(?:px|em|rem|%))$/i],
      border: [/^(?:none|0|\d+(?:\.\d+)?px\s+(?:solid|dashed|dotted)\s+(?:#[0-9a-f]{3,8}|[a-z]+))$/i],
      'border-radius': [/^(?:0|\d+(?:\.\d+)?(?:px|em|rem|%))(?:\s+(?:0|\d+(?:\.\d+)?(?:px|em|rem|%))){0,3}$/i],
      'border-collapse': [/^(?:collapse|separate)$/i],
      'vertical-align': [/^(?:baseline|top|middle|bottom|text-top|text-bottom)$/i],
      'white-space': [/^(?:normal|nowrap|pre|pre-wrap|pre-line)$/i]
    }
  },
  transformTags: { a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }, true) }
});

function sanitizeNewsletterHtml(value) {
  return sanitizeHtml(typeof value === 'string' ? value : '', NEWSLETTER_HTML_OPTIONS);
}

module.exports = { sanitizeNewsletterHtml, NEWSLETTER_HTML_OPTIONS };
