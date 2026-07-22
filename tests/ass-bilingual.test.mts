import assert from "node:assert/strict";
import test from "node:test";
import {
  addAssBilingualStyles,
  formatAssBilingualStyledText,
  getSmallerAssFontSize,
  normalizeAssFontName,
} from "../electron/main/utils/ass-bilingual.ts";

test("creates separate translation and smaller original styles", () => {
  const source = [
    {
      section: "V4+ Styles",
      body: [
        {
          key: "Style",
          value: {
            Name: "Default",
            Fontname: "Source Font",
            Fontsize: "20",
            Bold: "-1",
          },
        },
      ],
    },
  ];

  const { full, stylesBySource } = addAssBilingualStyles(source, {
    translationFont: "Noto Sans TC",
    originalFont: "Arial",
  });
  const styles = full[0].body.map((line) => line.value);

  assert.deepEqual(stylesBySource.get("Default"), {
    translation: "ST Translation 0",
    original: "ST Original 0",
  });
  assert.deepEqual(stylesBySource.get("*Default"), {
    translation: "ST Translation 0",
    original: "ST Original 0",
  });
  assert.deepEqual(styles[1], {
    Name: "ST Translation 0",
    Fontname: "Noto Sans TC",
    Fontsize: "20",
    Bold: "-1",
  });
  assert.deepEqual(styles[2], {
    Name: "ST Original 0",
    Fontname: "Arial",
    Fontsize: "12",
    PrimaryColour: "&H00FFFFFF",
    OutlineColour: "&H002F2F2F",
    BackColour: "&H00000000",
    Bold: "0",
  });
  assert.equal(source[0].body.length, 1);
});

test("switches named styles so original sizing cannot leak into translation", () => {
  assert.equal(
    formatAssBilingualStyledText({
      originalText: "Original",
      translatedText: "譯文",
      order: "original+translate",
      translationStyle: "ST Translation 0",
      originalStyle: "ST Original 0",
    }),
    "{\\rST Original 0}Original\\N{\\rST Translation 0}譯文"
  );
});

test("supports translated-first order and preserves source override tags", () => {
  assert.equal(
    formatAssBilingualStyledText({
      originalText: "{\\i1}Original",
      translatedText: "譯文",
      order: "translate+original",
      translationStyle: "ST Translation 0",
      originalStyle: "ST Original 0",
    }),
    "{\\rST Translation 0}譯文\\N{\\rST Original 0}{\\i1}Original"
  );
});

test("falls back to the reference 12px original size", () => {
  assert.equal(getSmallerAssFontSize(undefined), 12);
  assert.equal(getSmallerAssFontSize("not-a-number"), 12);
});

test("converts physical line breaks to ASS hard breaks", () => {
  assert.equal(
    formatAssBilingualStyledText({
      originalText: "Original line 1\nOriginal line 2",
      translatedText: "譯文第一行\n譯文第二行",
      order: "translate+original",
      translationStyle: "ST Translation 0",
      originalStyle: "ST Original 0",
    }),
    "{\\rST Translation 0}譯文第一行\\N譯文第二行\\N{\\rST Original 0}Original line 1\\NOriginal line 2"
  );
});

test("rejects characters that can break ASS fields or override blocks", () => {
  assert.equal(normalizeAssFontName(" Arial "), "Arial");
  assert.equal(normalizeAssFontName("Arial, sans-serif"), "");
  assert.equal(normalizeAssFontName("Arial}\\fs99"), "");
});
