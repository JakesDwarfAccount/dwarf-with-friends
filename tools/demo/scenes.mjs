// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only
//
// The showcase is data: add or edit scene entries here; demo.mjs is the generic runner.

export const scenes = [
  {
    id: "co-build",
    title: "Multiple cursors, one fortress",
    description: "Four named players place a wall together while the camera follows Urist_A.",
    durationMs: 18000,
    camera: { player: "DWF_Camera", follow: "Urist_A" },
    players: [
      { name: "Urist_A", steps: [
        { at: 800, action: "cursor", path: [[0.22, 0.40], [0.33, 0.48], [0.42, 0.55]] },
        { at: 2200, action: "build", search: "Wall", from: [0.38, 0.51], to: [0.46, 0.51] },
        { at: 10500, action: "chat", text: "West wall is queued." },
      ] },
      { name: "Urist_B", steps: [
        { at: 900, action: "cursor", path: [[0.72, 0.36], [0.64, 0.45], [0.56, 0.55]] },
        { at: 2200, action: "build", search: "Wall", from: [0.47, 0.51], to: [0.53, 0.51] },
        { at: 11000, action: "chat", text: "Center section ready." },
      ] },
      { name: "Urist_C", steps: [
        { at: 1000, action: "cursor", path: [[0.25, 0.72], [0.36, 0.65], [0.47, 0.58]] },
        { at: 2200, action: "build", search: "Wall", from: [0.54, 0.51], to: [0.60, 0.51] },
      ] },
      { name: "Urist_D", steps: [
        { at: 1100, action: "cursor", path: [[0.78, 0.70], [0.68, 0.64], [0.58, 0.57]] },
        { at: 2200, action: "build", search: "Wall", from: [0.61, 0.51], to: [0.68, 0.51] },
      ] },
    ],
  },
  {
    id: "designations",
    title: "Designations flow immediately",
    durationMs: 15000,
    camera: { player: "DWF_Camera", follow: "Urist_A" },
    players: [
      { name: "Urist_A", steps: [{ at: 1200, action: "designate", tool: "dig", from: [0.32, 0.43], to: [0.47, 0.57] }] },
      { name: "Urist_B", steps: [{ at: 1800, action: "designate", tool: "dig", from: [0.53, 0.43], to: [0.68, 0.57] }] },
      { name: "Urist_C", steps: [{ at: 7000, action: "pan", dx: 5, dy: 0, dz: 0 }] },
    ],
  },
  {
    id: "panel-tour",
    title: "Real fortress panels",
    durationMs: 18000,
    camera: { player: "DWF_Camera", steps: [
      { at: 1000, action: "panel", panel: "citizens" },
      { at: 5000, action: "panel", panel: "workorders" },
      { at: 9000, action: "panel", panel: "squads" },
      { at: 13000, action: "panel", panel: "stocks" },
    ] },
    players: [{ name: "Urist_A", steps: [{ at: 2500, action: "cursor", path: [[0.35, 0.45], [0.60, 0.55]] }] }],
  },
  {
    id: "spectate-follow",
    title: "Independent cameras and follow mode",
    durationMs: 16000,
    camera: { player: "DWF_Camera", follow: "Urist_B" },
    players: [
      { name: "Urist_A", steps: [{ at: 1500, action: "pan", dx: -8, dy: 3, dz: 0 }] },
      { name: "Urist_B", steps: [{ at: 1500, action: "pan", dx: 10, dy: -4, dz: -1 }, { at: 7000, action: "pan", dx: 6, dy: 5, dz: 1 }] },
    ],
  },
  {
    id: "chat",
    title: "Chat and announcements",
    durationMs: 16000,
    camera: { player: "DWF_Camera", steps: [
      { at: 700, action: "panel", panel: "chat" },
      { at: 10500, action: "panel", panel: "alerts" },
    ] },
    players: [
      { name: "Urist_A", steps: [{ at: 1500, action: "chat", text: "Found the new dining hall [[loc:0,0,0]]" }] },
      { name: "Urist_B", steps: [{ at: 4000, action: "chat", text: "On my way!" }] },
      { name: "Urist_C", steps: [{ at: 6500, action: "cursor", path: [[0.68, 0.40], [0.58, 0.52]] }] },
    ],
  },
  {
    id: "bare-url-join",
    title: "Join from a bare link",
    description: "Shows the actual first-visit name/password gate, then the fortress client.",
    durationMs: 16000,
    camera: { player: "Urist_New", start: "bare", steps: [
      { at: 2000, action: "join" },
      { at: 8500, action: "cursor", path: [[0.50, 0.50], [0.61, 0.55]] },
    ] },
    players: [{ name: "Urist_A", steps: [{ at: 9000, action: "chat", text: "Welcome to the fortress!" }] }],
  },
];
