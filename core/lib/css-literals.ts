// Owns CSS escape decoding and quoted-string contents, not stylesheet semantics or admission.
export function decodeCss(value: string): string {
  return value.replace(/\\(?:([0-9a-f]{1,6})(?:\r\n|[\t\n\f\r ])?|(\r\n|[\n\r\f])|([^\n\r\f]))/gi, (_, hex, newline, char) => {
    if (hex) {
      const code = parseInt(hex, 16);
      return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? '\ufffd' : String.fromCodePoint(code);
    }
    return newline ? '' : char;
  });
}
export const cssString = (value: string): string => value.replace(/[<"\\\n\r\f\0]/g, char => `\\${char.codePointAt(0)!.toString(16)} `);
