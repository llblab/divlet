// XML 1.0 equivalence-class witnesses; accepted prepared output is also checked by the real browser parser.
const wrap = body => `<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
export const svgResourceCases = [
  ...[9, 10, 13, 32, 160, 0xd7ff, 0xe000, 0xfffd, 0x10000, 0x10ffff].map(code => ({ name: `XML character ${code.toString(16)}`, text: wrap(`<text>&#${code};</text>`), accepted: true, expectedText: String.fromCodePoint(code) })),
  ...[0, 1, 8, 11, 12, 14, 31, 0xd800, 0xfffe, 0xffff].map(code => ({ name: `XML character refusal ${code.toString(16)}`, text: wrap(`<text>&#${code};</text>`), accepted: false })),
  ...[0, 1].map(code => ({ name: `literal XML character refusal ${code}`, text: wrap(`<text>${String.fromCharCode(code)}</text>`), accepted: false })),
  { name: 'ordinary namespace binding', text: '<svg xmlns="http://www.w3.org/2000/svg" xmlns:p="urn:test"><metadata><p:note/></metadata></svg>', accepted: true },
  { name: 'implicit reserved XML binding', text: '<svg xmlns="http://www.w3.org/2000/svg" xml:lang="en"/>', accepted: true },
  { name: 'reserved XML binding', text: '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xml="http://www.w3.org/XML/1998/namespace" xml:lang="en"/>', accepted: true },
  ...['xmlns:p=""', 'xmlns:p=" "', 'xmlns:p="http://www.w3.org/XML/1998/namespace"', 'xmlns:p="http://www.w3.org/2000/xmlns/"', 'xmlns:xml="urn:wrong"', 'xmlns:xmlns="urn:wrong"'].map(attr => ({ name: `namespace refusal ${attr}`, text: `<svg xmlns="http://www.w3.org/2000/svg" ${attr}/>`, accepted: false })),
  { name: 'unbound element prefix', text: wrap('<p:g/>'), accepted: false },
  { name: 'unbound attribute prefix', text: '<svg xmlns="http://www.w3.org/2000/svg" p:label="x"/>', accepted: false },
  { name: 'XML declaration', text: '<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg"/>', accepted: true },
  ...['<?xml?>', '<?xml version="1.1"?>', ' <?xml version="1.0"?>', '<?xml version="1.0" unknown="x"?>'].map(header => ({ name: `XML declaration refusal ${header}`, text: header + '<svg xmlns="http://www.w3.org/2000/svg"/>', accepted: false })),
];
