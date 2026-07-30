import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { render } from "takumi-js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const icon = await readFile(resolve(projectRoot, "build/icon.svg"), "utf8");
const iconSrc = `data:image/svg+xml;base64,${Buffer.from(icon).toString("base64")}`;
const outputPath = resolve(projectRoot, ".github/assets/social-preview.png");
const h = React.createElement;

const formatPill = (label) =>
  h(
    "span",
    {
      style: {
        padding: "8px 14px",
        border: "1px solid #d9d9d9",
        borderRadius: 999,
        color: "#555",
        fontSize: 18,
        fontWeight: 600,
        letterSpacing: "0.04em",
      },
    },
    label,
  );

const subtitleRow = ({ time, source, translation, active = false }) =>
  h(
    "div",
    {
      style: {
        display: "flex",
        gap: 16,
        padding: "18px 20px",
        border: active ? "1px solid #c9cdec" : "1px solid #e9e9e9",
        borderRadius: 16,
        background: active
          ? "linear-gradient(110deg, rgba(232,234,255,0.92), rgba(237,255,233,0.92))"
          : "rgba(255,255,255,0.88)",
      },
    },
    h(
      "div",
      {
        style: {
          width: 74,
          color: "#8a8a8a",
          fontSize: 15,
          fontVariantNumeric: "tabular-nums",
          paddingTop: 2,
        },
      },
      time,
    ),
    h(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: 7, flex: 1 } },
      h("div", { style: { color: "#111", fontSize: 20, fontWeight: 650 } }, source),
      h("div", { style: { color: "#666", fontSize: 18 } }, translation),
    ),
  );

const card = h(
  "div",
  {
    style: {
      width: "100%",
      height: "100%",
      display: "flex",
      position: "relative",
      overflow: "hidden",
      background: "#fbfbfa",
      color: "#111",
      fontFamily: "Geist",
    },
  },
  h("div", {
    style: {
      position: "absolute",
      width: 560,
      height: 560,
      right: -130,
      top: -210,
      borderRadius: "50%",
      background: "rgba(180,255,168,0.44)",
      filter: "blur(90px)",
    },
  }),
  h("div", {
    style: {
      position: "absolute",
      width: 480,
      height: 480,
      left: 430,
      bottom: -310,
      borderRadius: "50%",
      background: "rgba(167,176,255,0.38)",
      filter: "blur(90px)",
    },
  }),
  h(
    "div",
    {
      style: {
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        width: "48%",
        padding: "66px 40px 60px 72px",
        zIndex: 1,
      },
    },
    h(
      "div",
      { style: { display: "flex", alignItems: "center", gap: 16 } },
      h("img", { src: iconSrc, width: 64, height: 64 }),
      h("span", { style: { fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em" } }, "Subtitle Translator"),
    ),
    h(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: 22 } },
      h(
        "div",
        { style: { fontSize: 64, lineHeight: 1.03, fontWeight: 760, letterSpacing: "-0.055em" } },
        "Translate subtitles,",
        h("br"),
        "keep the context.",
      ),
      h(
        "div",
        { style: { maxWidth: 480, color: "#666", fontSize: 23, lineHeight: 1.4 } },
        "A focused desktop app for natural, context-aware subtitle translation with LLMs.",
      ),
    ),
    h("div", { style: { display: "flex", alignItems: "center", gap: 10 } }, ...["ASS", "SRT", "SSA", "VTT"].map(formatPill)),
  ),
  h(
    "div",
    {
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: "52%",
        padding: "54px 62px 54px 18px",
        zIndex: 1,
      },
    },
    h(
      "div",
      {
        style: {
          width: "100%",
          height: 508,
          overflow: "hidden",
          border: "1px solid rgba(20,20,20,0.14)",
          borderRadius: 28,
          background: "rgba(255,255,255,0.82)",
          boxShadow: "0 30px 80px rgba(30,30,30,0.14), 0 4px 12px rgba(30,30,30,0.05)",
        },
      },
      h(
        "div",
        {
          style: {
            height: 76,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 22px",
            borderBottom: "1px solid #e7e7e7",
            background: "rgba(252,252,252,0.96)",
          },
        },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 9 } },
          ...["#a3a3a3", "#a3a3a3", "#a3a3a3"].map((background) =>
            h("span", { style: { width: 13, height: 13, borderRadius: "50%", background } }),
          ),
        ),
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 10, color: "#555", fontSize: 17, fontWeight: 650 } },
          h("span", { style: { width: 8, height: 8, borderRadius: "50%", background: "#7bd66e" } }),
          "EN / FR · Translating 42%",
        ),
      ),
      h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 12, padding: "22px" } },
        subtitleRow({
          time: "00:42",
          source: "We should get going.",
          translation: "On devrait y aller.",
        }),
        subtitleRow({
          time: "00:45",
          source: "Before the rain starts.",
          translation: "Avant qu’il se mette à pleuvoir.",
          active: true,
        }),
        subtitleRow({
          time: "00:49",
          source: "I packed everything.",
          translation: "J’ai tout emballé.",
        }),
      ),
      h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 10, padding: "0 22px" } },
        h(
          "div",
          { style: { display: "flex", justifyContent: "space-between", color: "#777", fontSize: 15 } },
          h("span", null, "Preserving tone and timing"),
          h("span", null, "126 / 300"),
        ),
        h(
          "div",
          { style: { height: 8, overflow: "hidden", borderRadius: 999, background: "#ececec" } },
          h("div", {
            style: {
              width: "42%",
              height: "100%",
              borderRadius: 999,
              background: "linear-gradient(90deg, #a7b0ff, #b4ffa8)",
            },
          }),
        ),
      ),
    ),
  ),
);

const png = await render(card, { width: 1280, height: 640 });
await writeFile(outputPath, png);
console.log(`Generated ${outputPath}`);
