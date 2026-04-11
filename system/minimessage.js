import chalk from 'chalk';

const legacyColors = {
  black: "#000000",
  dark_blue: "#0000AA",
  dark_green: "#00AA00",
  dark_aqua: "#00AAAA",
  dark_red: "#AA0000",
  dark_purple: "#AA00AA",
  gold: "#FFAA00",
  gray: "#AAAAAA",
  dark_gray: "#555555",
  blue: "#5555FF",
  green: "#55FF55",
  aqua: "#55FFFF",
  red: "#FF5555",
  light_purple: "#FF55FF",
  yellow: "#FFFF55",
  white: "#FFFFFF"
};

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16),
  };
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function rgbToHex(r, g, b) {
  return "#" + [r, g, b].map(v => v.toString(16).padStart(2, "0")).join("");
}

function gradient(text, c1, c2) {
  const chars = [...text];

  return chars.map((ch, i) => {
    const t = chars.length <= 1 ? 0 : i / (chars.length - 1);

    const a = hexToRgb(c1);
    const b = hexToRgb(c2);

    const r = Math.round(lerp(a.r, b.r, t));
    const g = Math.round(lerp(a.g, b.g, t));
    const b2 = Math.round(lerp(a.b, b.b, t));

    return chalk.hex(rgbToHex(r, g, b2))(ch);
  }).join("");
}

export function miniMessage(text) {
  let bold = false;
  let italic = false;
  let underline = false;
  let strike = false;

  let color = null;

  function apply(str) {
    let out = chalk;

    if (color) out = out.hex(color);
    if (bold) out = out.bold;
    if (italic) out = out.italic;
    if (underline) out = out.underline;
    if (strike) out = out.strikethrough;

    return out(str);
  }

  text = text.replace(
    /<gradient:([^:>]+):([^>]+)>(.*?)<\/gradient>/gs,
    (_, c1, c2, inner) => gradient(inner, c1, c2)
  );

  const tokens = [...text.matchAll(/(<[^>]+>|[^<]+)/g)].map(m => m[0]);

  const result = [];

  for (let token of tokens) {
    if (!token) continue;

    const knownTags = new Set([
      "bold", "/bold",
      "italic", "/italic",
      "underlined", "/underlined",
      "strikethrough", "/strikethrough",
      "reset"
    ]);

    if (token.startsWith("<") && token.endsWith(">")) {
      const tag = token.slice(1, -1).toLowerCase();

      if (!knownTags.has(tag) && !tag.startsWith("color:") && !legacyColors[tag]) {
        result.push(token);
        continue;
      }

      if (tag === "bold") bold = true;
      else if (tag === "/bold") bold = false;

      else if (tag === "italic") italic = true;
      else if (tag === "/italic") italic = false;

      else if (tag === "underlined") underline = true;
      else if (tag === "/underlined") underline = false;

      else if (tag === "strikethrough") strike = true;
      else if (tag === "/strikethrough") strike = false;

      else if (tag === "reset") {
        bold = italic = underline = strike = false;
        color = null;
      }

      else if (tag.startsWith("color:")) {
        color = tag.split(":")[1];
      }

      else if (legacyColors[tag]) {
        color = legacyColors[tag];
      }

      continue;
    }

    result.push(apply(token));
  }

  return result.join('');
}