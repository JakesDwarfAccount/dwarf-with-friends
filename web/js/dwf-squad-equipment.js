// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, version 3 of the License.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.
//
// Runs on DFHack (Zlib); descends from DFPlex (Zlib) and webfort (ISC).
// Full license: see LICENSE. Third-party credits: see NOTICE.
//
// SPDX-License-Identifier: AGPL-3.0-only

  // --- Equip screen (native 5): sub-tabs Assign-uniform / Add-uniform / Ammo. ---

  window.UNIFORM_CATS = [
    [0, "Body armor"], [1, "Helm"], [2, "Legwear"], [3, "Gloves"],
    [4, "Footwear"], [5, "Shield"], [6, "Weapon"],
  ];
  const CHOICE_OPTIONS = [[0, "(none)"], [1, "any"], [2, "melee"], [4, "ranged"]];
  const UNIFORM_NEW_LABELS = ["New bodywear", "New headwear", "New legwear", "New handwear",
    "New footwear", "New shield", "New weapon"];

  function sqMaterialClassOptions(catalog, selected, esc = window.sqEsc) {
    const classes = Array.isArray(catalog && catalog.materialClasses) ? catalog.materialClasses : [];
    if (!classes.length) return [[-1, "any"]];
    return classes.map(mc => [mc.value, mc.value === -1 ? "any material" : String(mc.name || "")]);
  }

  function sqSubtypeName(catalog, cat, subtype, esc = window.sqEsc) {
    if (subtype < 0) return "any";
    const list = catalog && catalog.subtypes && catalog.subtypes[cat];
    if (Array.isArray(list)) {
      const hit = list.find(s => s.subtype === subtype);
      if (hit) return esc(hit.name);
    }
    return "subtype " + subtype;
  }

  function sqUniformAssignRows(members, uniforms, esc = window.sqEsc, picks = {}) {
    if (!Array.isArray(members) || !members.length) {
      return `<div class="info-message">This squad has no positions.</div>`;
    }
    const templates = Array.isArray(uniforms) ? uniforms : [];
    const options = templates.map(u => [u.id, u.name || ("Uniform " + u.id)]);
    return members.map(m => {
      const portrait = m.filled ? window.sqUnitPortrait(m) : "";
      const name = m.name || ("Unit " + m.unitId);
      const who = m.filled ? portrait +
        `<span class="squad-uassign-name-fit"${window.sqProfessionColorStyle(m)}>${DWFUI.bitmapTextHtml(name,
          { fitNativeLabel: { host: "parent" } })}</span>` : DWFUI.bitmapTextHtml("(empty)");
      const pick = picks[m.idx] != null ? picks[m.idx] : (templates.length ? templates[0].id : -1);
      const strip = window.sqEquipmentStrip(m);
      const items = Number(m.uniformItems) || 0;
      return `<div class="squad-uassign-row squad-uassign-matrix-row">
        <div class="squad-uassign-pos">${m.idx} &middot; ${esc(m.positionName || "")}</div>
        <div class="squad-uassign-who">${who}</div>
        <div class="squad-uassign-items" title="${items} uniform item${items === 1 ? "" : "s"} required">${strip ||
          DWFUI.bitmapTextHtml(items ? `${items} items` : "no uniform", { cls: "squad-uassign-items-text" })}</div>
        ${window.sqCyclerHtml("uniformPick", options, pick, { cls: "squad-uniform-select",
          dataset: { uniformPos: m.idx }, title: "Uniform template", empty: "No uniform templates",
          ariaLabel: "Uniform template for this position" })}
        ${DWFUI.plaqueBtnHtml({ label: "Apply", tone: "green", artTone: "neutral",
          dataset: { uniformApply: m.idx }, disabled: !templates.length,
          title: "Apply the cycled template to this position" })}
        ${DWFUI.plaqueBtnHtml({ label: "Clear", tone: "red", dataset: { uniformClear: m.idx },
          title: "Clear this position's uniform" })}
        ${DWFUI.artBtnHtml({ sprite: DWFUI.TOKENS.sprites.inspect, cls: "squad-uassign-inspect",
          dataset: { equipmentInspect: m.idx }, title: "Inspect this position's equipment", ariaLabel: "Inspect equipment" })}
        ${DWFUI.plaqueBtnHtml({ label: "Details", tone: "green", artTone: "neutral",
          dataset: { equipmentDetails: m.idx }, title: "Open equipment details" })}
      </div>`;
    }).join("");
  }

  function sqUniformTemplatePane(uniforms, esc = window.sqEsc) {
    const templates = Array.isArray(uniforms) ? uniforms : [];
    // Oracle 5.1: the template pane's rows are native's GREY slabs, not the lit-green toggle paint.
    const rows = templates.map(u => DWFUI.rowHtml({
      tag: "div", cls: "squad-uniform-template-row", chassis: "slab",
      dataset: { uniformTemplate: u.id }, label: u.name || ("Uniform " + u.id),
      trailing: DWFUI.artBtnHtml({ sprite: DWFUI.TOKENS.sprites.squadsDisband,
        cls: "squad-uniform-template-delete",
        dataset: { uniformTemplateDelete: u.id }, title: "Delete uniform template", ariaLabel: "Delete uniform template" }),
    })).join("") + DWFUI.rowHtml({
      tag: "div", cls: "squad-uniform-template-row squad-uniform-template-none", chassis: "slab",
      dataset: { uniformTemplate: -1 }, label: "No uniform",
    });
    return `<aside class="squad-uniform-template-pane">
      ${DWFUI.bitmapProseHtml("Choose a uniform for the selected squads.", 48, { cls: "squad-uniform-template-prompt" })}
      ${window.sqListHtml({ cls: "squad-uniform-template-list", rows: ".squad-uniform-template-row", preserveKey: "squads:uniform-templates" },
        rows || `<div class="info-message">No uniform templates.</div>`)}</aside>`;
  }

  // Add-uniform tab (native 5.2 + 5.2.1-5.2.7): fort-wide template authoring. The 7 categories
  // map to the native "New bodywear/headwear/legwear/handwear/footwear/shield/weapon" buttons.
  function sqUniformEditor(catalog, uniformSelId, esc = window.sqEsc, sel = {}) {
    if (!catalog) return `<div class="info-message">Uniform catalog unavailable.</div>`;
    const templates = Array.isArray(catalog.uniforms) ? catalog.uniforms : [];
    const tplOptions = templates.map(u => [u.id, u.name || ("Uniform " + u.id)]);
    const selected = templates.find(u => u.id === uniformSelId) || null;
    if (!selected) {
      const addButtons = UNIFORM_CATS.map(([cat]) => DWFUI.plaqueBtnHtml({
        label: UNIFORM_NEW_LABELS[cat], tone: "green", artTone: "neutral",
        cls: "squad-uniform-blank-category", disabled: true,
        title: "Name and save the uniform before adding equipment requirements",
      })).join("");
      return `<div class="squad-uniform-blank-head">
          ${DWFUI.textInputHtml({ cls: "squad-input squad-uniform-newname", id: "uniformNewName", maxLength: 19,
            placeholder: "<enter name here>" })}
          ${DWFUI.artBtnHtml({ sprite: DWFUI.TOKENS.sprites.quill,
            dataset: { uniformNameFocus: "new" }, title: "Name this uniform", ariaLabel: "Name this uniform" })}
          ${window.sqWithId(DWFUI.plaqueBtnHtml({ label: "Confirm and save uniform", tone: "green", artTone: "neutral",
            disabled: true, title: "Enter a name to save this uniform" }), "uniformCreateBtn")}
        </div>
        <div class="squad-controls squad-uniform-blank-categories">${addButtons}</div>
        <div class="squad-equipment-policy">
          ${DWFUI.plaqueBtnHtml({ label: "Uniform worn over clothing", tone: "green", artTone: "neutral", disabled: true })}
          ${DWFUI.plaqueBtnHtml({ label: "Partial matches okay", tone: "green", artTone: "neutral", disabled: true })}
        </div>`;
    }
    const body = sqUniformTemplateBody(catalog, selected, esc, sel);
    return `
      <div class="squad-controls">
        ${window.sqCyclerHtml("uniformSelect", tplOptions, uniformSelId, { cls: "squad-uniform-cycler",
          title: "Uniform template", empty: "No templates", ariaLabel: "Uniform template" })}
        ${DWFUI.textInputHtml({ cls: "squad-input squad-uniform-newname", id: "uniformNewName", maxLength: 19,
          placeholder: "New template name..." })}
        ${window.sqWithId(DWFUI.plaqueBtnHtml({ label: "Create", tone: "green", artTone: "neutral",
          title: "Create a new fort uniform template" }), "uniformCreateBtn")}
      </div>
      ${body}`;
  }

  function sqUniformTemplateBody(catalog, u, esc = window.sqEsc, sel = {}) {
    const items = Array.isArray(u.items) ? u.items : [];
    const subtypesByCat = catalog.subtypes || {};
    const drafts = sel.uitemDrafts || {};
    const flags = sel.uniformFlags || { replaceClothing: !!u.replaceClothing, exactMatches: !!u.exactMatches };
    const matOptions = sqMaterialClassOptions(catalog, -1, esc);
    const catRows = UNIFORM_CATS.map(([cat, label]) => {
      const catItems = items.filter(it => it.cat === cat);
      const itemRows = catItems.map(it => {
        const subName = sqSubtypeName(catalog, cat, it.subtype, esc);
        const mat = it.materialClass !== -1 ? esc(it.materialName || "") : "any";
        const choice = (CHOICE_OPTIONS.find(c => c[0] === it.choice) || [0, ""])[1];
        const bits = [subName, mat, it.color >= 0 ? ("color " + it.color) : "", cat === 6 && choice ? choice : ""].filter(Boolean).join(" &middot; ");
        return `<div class="squad-uitem-row">
          <span class="squad-uitem-desc">${bits}</span>
          ${DWFUI.artBtnHtml({ sprite: DWFUI.TOKENS.sprites.dump, cls: "squad-danger squad-uitem-remove",
            dataset: { ucat: cat, uindex: catItems.indexOf(it) },
            title: "Remove item", ariaLabel: "Remove item" })}
        </div>`;
      }).join("");
      const subOptions = [[-1, "any subtype"]].concat(
        (Array.isArray(subtypesByCat[cat]) ? subtypesByCat[cat] : [])
          .map(s => [s.subtype, s.name || ("subtype " + s.subtype)]));
      const d = drafts[cat] || {};
      const subtype = d.subtype != null ? d.subtype : -1;
      // The displayed default must be the value that gets POSTED: the cycler's default is the first option.
      const matclass = d.matclass != null ? d.matclass
        : (matOptions.length ? matOptions[0][0] : -1);
      const color = d.color != null ? d.color : -1;
      const choice = d.choice != null ? d.choice : 0;
      return `<div class="squad-ucat">
        <div class="squad-ucat-top">
          <div class="squad-ucat-head">${esc(label)}</div>
          <div class="squad-controls squad-uitem-add" data-ucat="${cat}">
            ${window.sqCyclerHtml("uitemSubtype", subOptions, subtype, { cls: "squad-uitem-subtype",
              dataset: { ucat: cat }, title: "Subtype", ariaLabel: `${label} subtype` })}
            ${window.sqCyclerHtml("uitemMat", matOptions, matclass, { cls: "squad-uitem-mat",
              dataset: { ucat: cat }, title: "Material", ariaLabel: `${label} material` })}
            ${window.sqStepperHtml({ cls: "squad-pos-input squad-uitem-color", inputCls: "squad-input squad-uitem-color-input",
              dataset: { uitemColor: cat }, label: "Dye", min: -1, max: 15, value: color,
              ariaLabel: "Dye color (0-15, -1 none)", title: "Dye color (0-15, -1 none)" })}
            ${cat === 6 ? DWFUI.segmentedHtml({ cls: "squad-uitem-choice", dataAttr: "uitem-choice",
              dataset: { ucat: cat }, ariaLabel: "Individual weapon choice", active: String(choice),
              options: CHOICE_OPTIONS.map(([v, l]) => ({ key: String(v), label: l })) }) : ""}
            ${DWFUI.plaqueBtnHtml({ label: "Add", tone: "green", artTone: "neutral",
              cls: "squad-uitem-addbtn", dataset: { uitemAdd: cat },
              title: `Add this ${String(label).toLowerCase()} requirement to the template` })}
          </div>
        </div>
        <div class="squad-uitem-list">${itemRows || `<span class="squad-empty">(none)</span>`}</div>
      </div>`;
    }).join("");
    return `
      <div class="squad-controls">
        ${DWFUI.textInputHtml({ cls: "squad-input", id: "uniformRenameInput", maxLength: 19,
          value: u.name || "" })}
        ${window.sqWithId(DWFUI.plaqueBtnHtml({ label: "Rename template", tone: "green", artTone: "neutral",
          title: "Rename this template" }), "uniformRenameBtn")}
        ${window.sqWithId(DWFUI.plaqueBtnHtml({ label: "Delete", tone: "red", cls: "squad-danger",
          title: "Delete this template (irreversible; squads that already applied it keep their copy)" }), "uniformDeleteBtn")}
      </div>
      <div class="squad-controls">
        <label class="squad-ammo-flag">${DWFUI.checkHtml({ checked: !!flags.replaceClothing,
          dataset: { uniformFlag: "replaceClothing" }, title: "Worn over clothing",
          ariaLabel: "Worn over clothing" })}Worn over clothing</label>
        <label class="squad-ammo-flag">${DWFUI.checkHtml({ checked: !!flags.exactMatches,
          dataset: { uniformFlag: "exactMatches" }, title: "Partial matches okay",
          ariaLabel: "Partial matches okay" })}Partial matches okay</label>
        ${window.sqWithId(DWFUI.plaqueBtnHtml({ label: "Save flags", tone: "green", artTone: "neutral",
          title: "Save the two template flags" }), "uniformFlagsBtn")}
      </div>
      <div class="squad-ucat-grid">${catRows}</div>`;
  }

  // Ammo tab (native 5.3): squad ammunition specs (subtype + material + amount + combat/train).
  function sqAmmoSection(detail, catalog, esc = window.sqEsc, sel = {}) {
    const specs = Array.isArray(detail && detail.ammo) ? detail.ammo : [];
    const defs = Array.isArray(detail && detail.ammoDefs) ? detail.ammoDefs : [];
    const rowDrafts = sel.ammoRowDrafts || {};
    const add = sel.ammoAdd || {};
    const rows = specs.length
      ? specs.map(a => {
          const name = esc(a.ammoName || ("Ammo #" + a.subtype));
          const mat = esc(a.materialName && a.materialClass !== -1 ? a.materialName : "any");
          const d = rowDrafts[a.index] || {};
          const amount = d.amount != null ? Number(d.amount) : (Number(a.amount) || 0);
          const combat = d.combat != null ? !!d.combat : !!a.combat;
          const training = d.training != null ? !!d.training : !!a.training;
          return `<div class="squad-ammo-row" data-ammo-index="${a.index}">
            <span class="squad-ammo-name">${name}</span>
            ${window.sqStepperHtml({ cls: "squad-ammo-amount", inputCls: "squad-input squad-ammo-amount-input",
              dataset: { ammoAmount: a.index }, min: 0, max: 9999, value: amount, ariaLabel: "Amount" })}
            <span class="squad-ammo-mat">${mat}</span>
            <label class="squad-ammo-flag">${DWFUI.checkHtml({ checked: combat, cls: "squad-ammo-combat",
              dataset: { ammoFlag: "combat", ammoIndex: a.index }, title: "Combat ammunition",
              ariaLabel: "Combat ammunition" })}C</label>
            <label class="squad-ammo-flag">${DWFUI.checkHtml({ checked: training, cls: "squad-ammo-training",
              dataset: { ammoFlag: "training", ammoIndex: a.index }, title: "Training ammunition",
              ariaLabel: "Training ammunition" })}T</label>
            ${DWFUI.plaqueBtnHtml({ label: "Save", tone: "green", artTone: "neutral",
              cls: "squad-ammo-update", dataset: { ammoSave: a.index }, title: "Save this row" })}
            ${DWFUI.artBtnHtml({ sprite: DWFUI.TOKENS.sprites.dump, cls: "squad-danger squad-ammo-remove",
              dataset: { ammoRemove: a.index }, title: "Remove", ariaLabel: "Remove this ammunition" })}
          </div>`;
        }).join("")
      : `<div class="info-message">No ammunition assigned. (${defs.length ? "add bolts/arrows below" : "ammo catalog unavailable"})</div>`;
    const defOptions = defs.map(d =>
      [d.subtype, (d.name || ("ammo " + d.subtype)) + (d.ammoClass ? " (" + d.ammoClass + ")" : "")]);
    const matOptions = sqMaterialClassOptions(catalog, -1, esc);
    const addSubtype = add.subtype != null ? add.subtype : (defs.length ? defs[0].subtype : -1);
    const addAmount = add.amount != null ? Number(add.amount) : 100;
    // Same rule as the uniform editor: the displayed default IS the posted default (the old
    // `select`'s first option), never a silent -1 behind a label saying something else.
    const addMat = add.matclass != null ? add.matclass : (matOptions.length ? matOptions[0][0] : -1);
    const addCombat = add.combat != null ? !!add.combat : true;
    const addTraining = !!add.training;
    return `
      ${window.sqListHtml({ cls: "squad-ammo-list", rows: ".squad-ammo-row", preserveKey: "squads:ammo" }, rows)}
      <div class="squad-controls squad-ammo-add">
        ${window.sqCyclerHtml("ammoType", defOptions, addSubtype, { cls: "squad-ammo-type", title: "Ammo type",
          empty: "No ammo types", ariaLabel: "Ammunition type" })}
        ${window.sqStepperHtml({ cls: "squad-pos-input squad-ammo-add-amount", inputCls: "squad-input squad-ammo-add-amount-input",
          dataset: { ammoAddAmount: "" }, label: "Amount", min: 0, max: 9999, value: addAmount,
          ariaLabel: "Amount" })}
        ${window.sqCyclerHtml("ammoMat", matOptions, addMat,
          { cls: "squad-ammo-matclass", title: "Material", ariaLabel: "Ammunition material" })}
        <label class="squad-ammo-flag">${DWFUI.checkHtml({ checked: addCombat,
          dataset: { ammoAddFlag: "combat" }, title: "Combat", ariaLabel: "Combat" })}Combat</label>
        <label class="squad-ammo-flag">${DWFUI.checkHtml({ checked: addTraining,
          dataset: { ammoAddFlag: "training" }, title: "Train", ariaLabel: "Train" })}Train</label>
        ${window.sqWithId(DWFUI.plaqueBtnHtml({ label: "Add", tone: "green", artTone: "neutral",
          disabled: !defs.length, title: "Add this ammunition spec" }), "squadAmmoAddBtn")}
        ${window.sqWithId(DWFUI.plaqueBtnHtml({ label: "Clear all", tone: "red", disabled: !specs.length,
          title: "Remove every ammunition spec" }), "squadAmmoClearBtn")}
      </div>`;
  }

  // Supplies tab (native 5.4): per-squad food/water each member carries.
  const SUPPLY_FOOD_OPTIONS = [[3, "3 food"], [2, "2 food"], [1, "1 food"], [0, "No food"]];
  const SUPPLY_WATER_OPTIONS = [["drink", "Drink"], ["water", "Water"], ["nowater", "No water"]];

  function sqSuppliesSection(detail, esc = window.sqEsc) {
    const supplies = detail && detail.supplies;
    if (!supplies) {
      return `<div class="info-message">This build does not serve squad supplies, so they cannot be edited here.</div>`;
    }
    const food = Number(supplies.food);
    const water = String(supplies.water || "none");
    return `
      <div class="squad-section-title">Supplies carried by each squad member</div>
      <div class="squad-controls squad-supply-row">${DWFUI.segmentedHtml({
        cls: "squad-supply-food", dataAttr: "supply-food", active: String(food),
        ariaLabel: "Food carried by each squad member",
        options: SUPPLY_FOOD_OPTIONS.map(([v, label]) => ({ key: String(v), label })),
      })}</div>
      <div class="squad-controls squad-supply-row">${DWFUI.segmentedHtml({
        cls: "squad-supply-water", dataAttr: "supply-water", active: water,
        ariaLabel: "Water carried by each squad member",
        options: SUPPLY_WATER_OPTIONS.map(([v, label]) => ({ key: String(v), label })),
      })}</div>`;
  }

  function sqEquipmentItemLabel(item, cat, esc = window.sqEsc) {
    const assigned = Number(item.assignedCount) || 0;
    if (assigned > 1) return `${assigned} assigned items`;
    const material = item.materialName || (item.materialClass >= 0 ? item.materialClassName : "any");
    const name = item.itemName || (UNIFORM_CATS.find(c => c[0] === cat) || [0, "item"])[1];
    return esc(`${material && material !== "any" ? material + " " : ""}${name}`);
  }

  function sqEquipmentPickerView(detail, catalog, posIndex, picker, esc = window.sqEsc) {
    const squad = detail && detail.squad;
    const members = Array.isArray(squad && squad.members) ? squad.members : [];
    const member = members.find(m => Number(m.idx) === Number(posIndex));
    if (!member || !picker) return `<div class="info-message">Equipment item unavailable.</div>`;
    const title = picker.kind === "color" ? "Select color." : "Select material.";
    const pickerRow = (dataset, label) => DWFUI.rowHtml({
      tag: "button", cls: "squad-create-row squad-picker-row", chassis: "slab",
      dataset, labelHtml: DWFUI.bitmapTextHtml(String(label), { cls: "squad-picker-row-text" }),
      labelCls: "squad-pos-role",
    });
    let rows = "";
    if (picker.kind === "color") {
      const colors = Array.isArray(catalog && catalog.colors) ? catalog.colors : [];
      rows = pickerRow({ equipmentPickColor: -1 }, "any color") +
        colors.map(color => pickerRow({ equipmentPickColor: color.value },
          color.name || ("color " + color.value))).join("");
    } else {
      const classes = Array.isArray(catalog && catalog.materialClasses) ? catalog.materialClasses : [];
      const materials = Array.isArray(catalog && catalog.materials) ? catalog.materials : [];
      rows = pickerRow({ equipmentPickMaterial: "class:-1" }, "any material") +
        classes.filter(mc => Number(mc.value) >= 0)
          .map(mc => pickerRow({ equipmentPickMaterial: `class:${mc.value}` }, mc.name)).join("") +
        materials.map(mat => pickerRow(
          { equipmentPickMaterial: `material:${mat.mattype}:${mat.matindex}` }, mat.name)).join("");
    }
    return `${window.sqBackHeader(squad, esc)}
      <div class="squad-back-head">${window.sqWithId(DWFUI.plaqueBtnHtml({ label: "Equipment details",
        tone: "green", cls: "squad-back-plaque" }), "equipmentPickerBackBtn")}<div class="squad-back-title">${title}</div></div>
      ${window.sqListHtml({ cls: "squad-picker-list", rows: ".squad-picker-row", preserveKey: `squads:picker:${picker.kind}` },
        rows || `<div class="info-message">No choices were served by this build.</div>`)}`;
  }

  function sqEquipmentDetails(detail, catalog, posIndex, picker, esc = window.sqEsc) {
    if (picker) return sqEquipmentPickerView(detail, catalog, posIndex, picker, esc);
    const squad = detail && detail.squad;
    if (!squad) return `<div class="info-message">Select a squad.</div>`;
    const members = Array.isArray(squad.members) ? squad.members : [];
    const member = members.find(m => Number(m.idx) === Number(posIndex)) || members[0];
    if (!member) return `<div class="info-message">This squad has no positions.</div>`;
    const posOptions = members.map(m =>
      [m.idx, `Position ${Number(m.idx) + 1}${m.name ? " - " + m.name : ""}`]);
    const items = Array.isArray(member.uniformDetails) ? member.uniformDetails : [];
    const rows = items.map(item => {
      const cat = Number(item.cat);
      const label = (UNIFORM_CATS.find(c => c[0] === cat) || [0, "Equipment"])[1];
      const classLabel = item.materialClass >= 0 ? item.materialClassName : (item.materialName || "any material");
      const slot = window.UNIFORM_CAT_SLOT[cat];
      const good = (Number(item.assignedCount) || 0) > 0;
      const slotSprite = slot && DWFUI.TOKENS.sprites[`squadsEquip${slot}${good ? "Good" : "Missing"}`];
      return `<div class="squad-uassign-row squad-equipment-row">
        <div class="squad-uassign-pos">${slotSprite ? DWFUI.iconHtml({ sprite: slotSprite,
          nativeCell: true, cls: "squad-equip-slot", alt: `${label}: ${good ? "assigned" : "missing"}`,
          title: good ? `${label} -- ${item.assignedCount} item(s) assigned` : `${label} -- MISSING (no item assigned)` }) : ""
        }${esc(String(classLabel || "any"))} ${esc(label.toLowerCase())}</div>
        <div class="squad-uassign-who">${sqEquipmentItemLabel(item, cat, esc)}</div>
        ${DWFUI.plaqueBtnHtml({ label: "Mat", tone: "green", artTone: "neutral",
          dataset: { equipmentMaterial: `${cat}:${item.index}` }, title: "Choose the material" })}
        ${DWFUI.plaqueBtnHtml({ label: "Color", tone: "green", artTone: "neutral",
          dataset: { equipmentColor: `${cat}:${item.index}` }, title: "Choose the dye colour" })}
        ${DWFUI.artBtnHtml({ sprite: DWFUI.TOKENS.sprites.dump, cls: "squad-danger",
          dataset: { equipmentRemove: `${cat}:${item.index}` },
          title: "Remove this equipment requirement", ariaLabel: "Remove this equipment requirement" })}
      </div>`;
    }).join("");
    const add = UNIFORM_CATS.map(([cat, label]) => DWFUI.plaqueBtnHtml({
      label: UNIFORM_NEW_LABELS[cat], tone: "green", artTone: "neutral",
      dataset: { equipmentAdd: cat }, title: `Add a ${String(label).toLowerCase()} requirement` })).join("");
    return `${DWFUI.bitmapProseHtml(
        "Saving this position as a fort uniform template is not served (DEF-112). Equipment requirements below remain editable.",
        72, { cls: "squad-equip-save-gap" })}
      <div class="squad-section-title">${esc(squad.alias || squad.name || "Squad")} · Position ${Number(member.idx) + 1}</div>
      <div class="squad-controls"><span class="squad-field-label">Edit position</span>${
        window.sqCyclerHtml("equipPos", posOptions, member.idx, { cls: "squad-equipment-pos",
          title: "Position", ariaLabel: "Position being edited" })}</div>
      ${window.sqListHtml({ cls: "squad-equipment-list", rows: ".squad-equipment-row", preserveKey: "squads:equipment" },
        rows || `<div class="info-message">No equipment requirements for this position.</div>`)}
      <div class="squad-controls squad-equipment-add">${add}</div>
      <div class="squad-equipment-policy" aria-label="Uniform policy">
        ${DWFUI.plaqueBtnHtml({ label: "Uniform worn over clothing", tone: "green", artTone: "neutral",
          cls: "squad-equipment-policy-btn", disabled: true,
          title: "This squad-position policy is not served by the current game bridge" })}
        ${DWFUI.plaqueBtnHtml({ label: "Exact matches only", tone: "green", artTone: "neutral",
          cls: "squad-equipment-policy-btn", disabled: true,
          title: "This squad-position policy is not served by the current game bridge" })}
      </div>`;
  }

  // ---- Four nav plaques, not five: `details` is reached from a member row, never from the nav. ----
  window.EQUIP_TABS = [["uniform", "Assign uniform"], ["add", "Add uniform"], ["ammo", "Ammo"],
    ["supplies", "Supplies"]];
  // `details` is a legal view with no plaque -- keep the two lists apart so the nav never regrows a fifth.
  window.EQUIP_VIEWS = EQUIP_TABS.map(([key]) => key).concat("details");

  function sqEquipView(detail, catalog, tab, uniformSelId, posIndex = 0, picker = null, esc = window.sqEsc, sel = {}) {
    const squad = detail && detail.squad;
    if (!squad) return `<div class="info-message">Select a squad.</div>`;
    const active = EQUIP_VIEWS.includes(tab) ? tab : "uniform";
    const nav = EQUIP_TABS.map(([key, label]) => DWFUI.plaqueBtnHtml({
      label, tone: "green", artTone: "neutral", cls: "squad-tab" + (key === active ? " active" : ""),
      dataset: { equipTab: key }, focus: key === active,
      title: `Equip: ${label}`,
    })).join("");
    let body;
    if (active === "add") {
      body = sqUniformEditor(catalog, uniformSelId, esc, sel);
    } else if (active === "ammo") {
      body = sqAmmoSection(detail, catalog, esc, sel);
    } else if (active === "supplies") {
      body = sqSuppliesSection(detail, esc);
    } else if (active === "details") {
      body = sqEquipmentDetails(detail, catalog, posIndex, picker, esc);
    } else {
      const uniforms = Array.isArray(detail.uniforms) ? detail.uniforms : [];
      const members = Array.isArray(squad.members) ? squad.members : [];
      body = `<div class="squad-uniform-assign-layout">${sqUniformTemplatePane(uniforms, esc)}
        ${window.sqListHtml({ cls: "squad-uassign-list", rows: ".squad-uassign-matrix-row", preserveKey: "squads:uassign" },
          sqUniformAssignRows(members, uniforms, esc, sel.uniformPick || {}))}</div>`;
    }
    const squadName = esc(squad.alias || squad.name || ("Squad " + squad.id));
    const confirm = DWFUI.plaqueBtnHtml({ label: "Confirm", tone: "green", artTone: "neutral",
      dataset: { equipTab: "uniform" }, title: "Return to squad equipment" });
    let header;
    if (active === "uniform") {
      header = `<div class="squad-tabbar squad-equip-native-nav">${nav}<span class="squad-equip-nav-spacer"></span>${
        DWFUI.plaqueBtnHtml({ label: "Update equipment", tone: "green", artTone: "neutral",
          disabled: true, title: "Native equipment refresh; automatic in Dwarf With Friends" })}</div>`;
    } else if (active === "add") {
      header = `<div class="squad-equip-native-head"><div class="squad-equip-native-title">Adding uniform</div>
        <div class="squad-equip-native-head-actions">${confirm}</div></div>`;
    } else if (active === "ammo") {
      header = `<div class="squad-equip-native-head"><div class="squad-equip-native-identity">${window.sqEmblemSwatch(squad, esc)}<span>${squadName}</span></div>
        <div class="squad-equip-native-head-actions">${DWFUI.plaqueBtnHtml({ label: "Add ammunition", tone: "green", artTone: "neutral",
          dataset: { ammoHeaderAdd: "" }, title: "Move to the add-ammunition controls below" })}${confirm}</div></div>`;
    } else if (active === "supplies") {
      header = `<div class="squad-equip-native-head"><div class="squad-equip-native-title">Supplies carried by each squad member</div>
        <div class="squad-equip-native-head-actions">${confirm}</div></div>
        <div class="squad-equip-native-identity squad-equip-supply-identity">${window.sqEmblemSwatch(squad, esc)}<span>${squadName}</span></div>`;
    } else {
      const member = (Array.isArray(squad.members) ? squad.members : []).find(m => Number(m.idx) === Number(posIndex));
      header = `<div class="squad-equip-native-head"><div class="squad-equip-native-identity">${window.sqEmblemSwatch(squad, esc)}
          <span>${squadName}<br>Position ${Number(member?.idx ?? posIndex) + 1}</span></div>
        <div class="squad-equip-native-head-actions">${confirm}${DWFUI.textInputHtml({ cls: "squad-input squad-equip-name",
          placeholder: "<name unavailable>", ariaLabel: "Uniform name unavailable", disabled: true,
          title: "Saving a position uniform as a fort template is not served (DEF-112)" })}
          ${DWFUI.artBtnHtml({ sprite: DWFUI.TOKENS.sprites.quill, disabled: true,
            title: "Saving a position uniform as a fort template is not served (DEF-112)",
            ariaLabel: "Uniform naming unavailable" })}
          ${DWFUI.plaqueBtnHtml({ label: "Confirm and save uniform", tone: "green", artTone: "neutral", disabled: true,
            title: "Saving a position uniform as a fort template is not served (DEF-112)" })}</div></div>`;
    }
    return `${header}
      <div id="squadStatus" class="info-message squad-status"></div>
      <div class="squad-tab-body squad-equip-native-body">${body}</div>`;
  }

  // --- Schedule screen (native 7): one selected squad across routine columns. ---
  // --- uniform assignment wiring (existing templates only) ---

  async function squadUniformPost(params) {
    const q = new URLSearchParams(Object.assign({ player }, params)).toString();
    return window.squadFetchJson(`/squad-uniform?${q}&t=${Date.now()}`, { method: "POST" });
  }

  // The per-position template chooser is now a CYCLER; its value lives in `window.DFSquadController.uniformPick` (seeded, like
  // the old `select`'s first option, from the first served template). Apply POSTs the same uniform id.
  function wireSquadUniformControls(squad) {
    clientPanel.querySelectorAll("[data-equipment-details],[data-equipment-inspect]").forEach(button => {
      button.addEventListener("click", () => {
        window.setEquipmentPosition(squad.id, Number(button.dataset.equipmentDetails ?? button.dataset.equipmentInspect));
        window.DFSquadController.equipTab = "details";
        window.DFSquadController.equipmentPicker = null;
        window.renderSquadsPanel();
      });
    });
    clientPanel.querySelectorAll("[data-uniform-template-delete]").forEach(button => {
      button.addEventListener("click", async event => {
        event.stopPropagation();
        try {
          await uniformPost("uniform-delete", { id: Number(button.dataset.uniformTemplateDelete) });
          window.DFSquadController.squadStatusMsg = "Uniform template deleted.";
        } catch (err) { window.DFSquadController.squadStatusMsg = err.message || "Could not delete template."; }
        await refreshAfterUniformEdit();
      });
    });
    // Native's template pane is the apply action, not decoration. One template row applies to every
    // served position in the current squad; the terminal No uniform row clears the same scope.
    clientPanel.querySelectorAll("[data-uniform-template]").forEach(row => {
      row.addEventListener("click", async event => {
        if (event.target && event.target.closest("[data-uniform-template-delete]")) return;
        const uniform = Number(row.dataset.uniformTemplate);
        const positions = (Array.isArray(squad.members) ? squad.members : [])
          .map(member => Number(member.idx)).filter(Number.isFinite);
        let written = 0;
        try {
          for (const pos of positions) {
            await squadUniformPost(uniform >= 0
              ? { squad: squad.id, pos, action: "apply", uniform }
              : { squad: squad.id, pos, action: "clear" });
            written++;
          }
          window.DFSquadController.squadStatusMsg = uniform >= 0 ? "Uniform applied to squad." : "Squad uniforms cleared.";
        } catch (err) {
          const base = err.message || "Could not update the squad uniform.";
          window.DFSquadController.squadStatusMsg = written ? `${base} (${written} of ${positions.length} positions updated.)` : base;
        }
        await window.loadSquadDetail(squad.id);
      });
    });
    clientPanel.querySelectorAll("[data-uniform-apply]").forEach(button => {
      button.addEventListener("click", async () => {
        const pos = Number(button.dataset.uniformApply);
        const templates = Array.isArray(window.DFSquadController.squadDetail && window.DFSquadController.squadDetail.uniforms) ? window.DFSquadController.squadDetail.uniforms : [];
        const uniform = window.DFSquadController.uniformPick[pos] != null ? Number(window.DFSquadController.uniformPick[pos])
          : (templates.length ? Number(templates[0].id) : -1);
        if (!(uniform >= 0)) { window.DFSquadController.squadStatusMsg = "No uniform template selected."; window.renderSquadsPanel(); return; }
        try {
          await squadUniformPost({ squad: squad.id, pos, action: "apply", uniform });
          window.DFSquadController.squadStatusMsg = "Uniform applied.";
        } catch (err) { window.DFSquadController.squadStatusMsg = err.message || "Could not apply uniform."; }
        await window.loadSquadDetail(squad.id);
      });
    });
    clientPanel.querySelectorAll("[data-uniform-clear]").forEach(button => {
      button.addEventListener("click", async () => {
        const pos = Number(button.dataset.uniformClear);
        try {
          await squadUniformPost({ squad: squad.id, pos, action: "clear" });
          window.DFSquadController.squadStatusMsg = "Uniform cleared.";
        } catch (err) { window.DFSquadController.squadStatusMsg = err.message || "Could not clear uniform."; }
        await window.loadSquadDetail(squad.id);
      });
    });
  }

  async function squadEquipmentPost(params) {
    const q = new URLSearchParams(Object.assign({ player }, params)).toString();
    return window.squadFetchJson(`/squad-equipment?${q}&t=${Date.now()}`, { method: "POST" });
  }

  function wireSquadEquipmentControls(squad) {
    // 0081 R15: the position every write posts is resolved from the PAIR at the moment of the write,
    // clamped to a position this squad actually has.
    const equipPos = () => Number((window.equipmentMemberFor(squad) || {}).idx) || 0;
    const currentItem = () => {
      if (!window.DFSquadController.equipmentPicker) return null;
      const member = window.equipmentMemberFor(squad);
      const details = Array.isArray(member && member.uniformDetails) ? member.uniformDetails : [];
      return details.find(item => Number(item.cat) === Number(window.DFSquadController.equipmentPicker.cat) && Number(item.index) === Number(window.DFSquadController.equipmentPicker.index)) || null;
    };
    const saveItem = async (item, changes) => {
      const next = Object.assign({
        squad: squad.id, pos: equipPos(), action: "update", cat: item.cat, index: item.index,
        subtype: item.subtype, matclass: item.materialClass, mattype: item.mattype,
        matindex: item.matindex, color: item.color, choice: item.choice,
      }, changes || {});
      await squadEquipmentPost(next);
      window.DFSquadController.equipmentPicker = null;
      await window.loadSquadDetail(squad.id);
    };

    clientPanel.querySelectorAll("[data-equipment-material], [data-equipment-color]").forEach(button => {
      button.addEventListener("click", () => {
        const encoded = button.dataset.equipmentMaterial || button.dataset.equipmentColor;
        const [cat, index] = String(encoded).split(":").map(Number);
        window.DFSquadController.equipmentPicker = { kind: button.dataset.equipmentColor != null ? "color" : "material", cat, index };
        window.renderSquadsPanel();
      });
    });
    clientPanel.querySelector("#equipmentPickerBackBtn")?.addEventListener("click", () => {
      window.DFSquadController.equipmentPicker = null;
      window.renderSquadsPanel();
    });
    clientPanel.querySelectorAll("[data-equipment-remove]").forEach(button => {
      button.addEventListener("click", async () => {
        const [cat, index] = String(button.dataset.equipmentRemove).split(":").map(Number);
        try {
          await squadEquipmentPost({ squad: squad.id, pos: equipPos(), action: "remove", cat, index });
          window.DFSquadController.squadStatusMsg = "Equipment requirement removed.";
        } catch (err) { window.DFSquadController.squadStatusMsg = err.message || "Could not remove equipment requirement."; }
        await window.loadSquadDetail(squad.id);
      });
    });
    clientPanel.querySelectorAll("[data-equipment-add]").forEach(button => {
      button.addEventListener("click", async () => {
        const cat = Number(button.dataset.equipmentAdd);
        try {
          await squadEquipmentPost({ squad: squad.id, pos: equipPos(), action: "add", cat,
            subtype: -1, matclass: -1, mattype: -1, matindex: -1, color: -1, choice: cat === 6 ? 2 : 0 });
          window.DFSquadController.squadStatusMsg = "Equipment requirement added.";
        } catch (err) { window.DFSquadController.squadStatusMsg = err.message || "Could not add equipment requirement."; }
        await window.loadSquadDetail(squad.id);
      });
    });
    clientPanel.querySelectorAll("[data-equipment-pick-material]").forEach(button => {
      button.addEventListener("click", async () => {
        const item = currentItem();
        if (!item) return;
        const parts = String(button.dataset.equipmentPickMaterial).split(":");
        try {
          if (parts[0] === "class") await saveItem(item, { matclass: Number(parts[1]), mattype: -1, matindex: -1 });
          else await saveItem(item, { matclass: -1, mattype: Number(parts[1]), matindex: Number(parts[2]) });
          window.DFSquadController.squadStatusMsg = "Equipment material saved.";
        } catch (err) { window.DFSquadController.squadStatusMsg = err.message || "Could not save equipment material."; window.renderSquadsPanel(); }
      });
    });
    clientPanel.querySelectorAll("[data-equipment-pick-color]").forEach(button => {
      button.addEventListener("click", async () => {
        const item = currentItem();
        if (!item) return;
        try {
          await saveItem(item, { color: Number(button.dataset.equipmentPickColor) });
          window.DFSquadController.squadStatusMsg = "Equipment color saved.";
        } catch (err) { window.DFSquadController.squadStatusMsg = err.message || "Could not save equipment color."; window.renderSquadsPanel(); }
      });
    });
  }

  // --- squad ammunition editor wiring ---
  async function squadAmmoPost(params) {
    const q = new URLSearchParams(Object.assign({ player }, params)).toString();
    return window.squadFetchJson(`/squad-ammo?${q}&t=${Date.now()}`, { method: "POST" });
  }

  function wireSquadAmmoControls(squad) {
    const defs = Array.isArray(window.DFSquadController.squadDetail && window.DFSquadController.squadDetail.ammoDefs) ? window.DFSquadController.squadDetail.ammoDefs : [];
    const specs = Array.isArray(window.DFSquadController.squadDetail && window.DFSquadController.squadDetail.ammo) ? window.DFSquadController.squadDetail.ammo : [];
    const matOptions = sqMaterialClassOptions(window.DFSquadController.uniformCatalog, -1);
    const addDraft = () => Object.assign({
      subtype: defs.length ? Number(defs[0].subtype) : -1, amount: 100,
      matclass: matOptions.length ? Number(matOptions[0][0]) : -1,
      combat: true, training: false,
    }, window.DFSquadController.ammoAddDraft || {});
    const rowDraft = index => {
      const served = specs.find(a => Number(a.index) === Number(index)) || {};
      return Object.assign({
        amount: Number(served.amount) || 0, combat: !!served.combat, training: !!served.training,
      }, window.DFSquadController.ammoRowDrafts[index] || {});
    };

    clientPanel.querySelector("[data-ammo-header-add]")?.addEventListener("click", () => {
      const addRow = clientPanel.querySelector(".squad-ammo-add");
      addRow?.scrollIntoView({ block: "nearest" });
      const first = addRow?.querySelector("[data-sq-cyc], input:not([disabled]), button:not([disabled])");
      first?.focus();
      window.squadSetStatus("Choose the ammunition type and amount below.");
    });

    // add-row amount (the stepper's editable input) + the two add-row check tiles
    const addAmountInput = clientPanel.querySelector(".squad-ammo-add-amount-input");
    addAmountInput?.addEventListener("input", () => {
      window.DFSquadController.ammoAddDraft = Object.assign(addDraft(), { amount: Number(addAmountInput.value) || 0 });
    });
    clientPanel.querySelectorAll("[data-ammo-add-flag]").forEach(tile => {
      tile.addEventListener("click", () => {
        const flag = tile.dataset.ammoAddFlag;
        const d = addDraft();
        window.DFSquadController.ammoAddDraft = Object.assign(d, { [flag]: !d[flag] });
        window.renderSquadsPanel();
      });
    });
    clientPanel.querySelector("#squadAmmoAddBtn")?.addEventListener("click", async () => {
      const d = addDraft();
      const subtype = Number(d.subtype);
      if (!(subtype >= 0)) { window.DFSquadController.squadStatusMsg = "Pick an ammo type."; window.renderSquadsPanel(); return; }
      const amount = Number(addAmountInput ? addAmountInput.value : d.amount) || 0;
      const matclass = Number(d.matclass ?? -1);
      const combat = d.combat ? 1 : 0;
      const training = d.training ? 1 : 0;
      try {
        await squadAmmoPost({ squad: squad.id, action: "add", subtype, amount, matclass, combat, training });
        window.DFSquadController.squadStatusMsg = "Ammunition added.";
      } catch (err) { window.DFSquadController.squadStatusMsg = err.message || "Could not add ammunition."; }
      window.DFSquadController.ammoAddDraft = null;
      await window.loadSquadDetail(squad.id);
    });
    clientPanel.querySelector("#squadAmmoClearBtn")?.addEventListener("click", async () => {
      try {
        await squadAmmoPost({ squad: squad.id, action: "clear" });
        window.DFSquadController.squadStatusMsg = "Ammunition cleared.";
      } catch (err) { window.DFSquadController.squadStatusMsg = err.message || "Could not clear ammunition."; }
      window.DFSquadController.ammoRowDrafts = {};
      await window.loadSquadDetail(squad.id);
    });
    clientPanel.querySelectorAll("[data-ammo-flag]").forEach(tile => {
      tile.addEventListener("click", () => {
        const index = Number(tile.dataset.ammoIndex);
        const flag = tile.dataset.ammoFlag;
        const d = rowDraft(index);
        window.DFSquadController.ammoRowDrafts[index] = Object.assign(d, { [flag]: !d[flag] });
        window.renderSquadsPanel();
      });
    });
    clientPanel.querySelectorAll(".squad-ammo-row").forEach(row => {
      const index = Number(row.dataset.ammoIndex);
      const amountInput = row.querySelector(".squad-ammo-amount-input");
      amountInput?.addEventListener("input", () => {
        window.DFSquadController.ammoRowDrafts[index] = Object.assign(rowDraft(index), { amount: Number(amountInput.value) || 0 });
      });
      row.querySelector("[data-ammo-save]")?.addEventListener("click", async () => {
        const d = rowDraft(index);
        const amount = Number(amountInput ? amountInput.value : d.amount) || 0;
        const combat = d.combat ? 1 : 0;
        const training = d.training ? 1 : 0;
        try {
          await squadAmmoPost({ squad: squad.id, action: "update", index, amount, combat, training });
          window.DFSquadController.squadStatusMsg = "Ammunition updated.";
        } catch (err) { window.DFSquadController.squadStatusMsg = err.message || "Could not update ammunition."; }
        delete window.DFSquadController.ammoRowDrafts[index];
        await window.loadSquadDetail(squad.id);
      });
      row.querySelector("[data-ammo-remove]")?.addEventListener("click", async () => {
        try {
          await squadAmmoPost({ squad: squad.id, action: "remove", index });
          window.DFSquadController.squadStatusMsg = "Ammunition removed.";
        } catch (err) { window.DFSquadController.squadStatusMsg = err.message || "Could not remove ammunition."; }
        window.DFSquadController.ammoRowDrafts = {};
        await window.loadSquadDetail(squad.id);
      });
    });
  }

  // --- uniform-template editor wiring (fort-wide /uniform-*) ---
  async function uniformPost(path, params) {
    const q = new URLSearchParams(Object.assign({ player }, params)).toString();
    return window.squadFetchJson(`/${path}?${q}&t=${Date.now()}`, { method: "POST" });
  }

  async function refreshAfterUniformEdit() {
    await window.loadUniformCatalog();
    if (window.DFSquadController.squadSelectedId >= 0) { await window.loadSquadDetail(window.DFSquadController.squadSelectedId); }
    else { window.renderSquadsPanel(); }
  }

  // The template chooser is the CYCLER (wireCyclers key "uniformSelect"); it writes the same
  // `window.DFSquadController.uniformSelectedId` the `select`'s change handler wrote.
  function wireUniformEditorControls() {
    const templates = Array.isArray(window.DFSquadController.uniformCatalog && window.DFSquadController.uniformCatalog.uniforms) ? window.DFSquadController.uniformCatalog.uniforms : [];
    const selected = templates.find(u => u.id === window.DFSquadController.uniformSelectedId) || null;
    if (!window.DFSquadController.uniformFlagDraft && selected) {
      window.DFSquadController.uniformFlagDraft = { replaceClothing: !!selected.replaceClothing, exactMatches: !!selected.exactMatches };
    }
    const newNameInput = clientPanel.querySelector("#uniformNewName");
    const createButton = clientPanel.querySelector("#uniformCreateBtn");
    clientPanel.querySelector("[data-uniform-name-focus]")?.addEventListener("click", () => {
      newNameInput?.focus();
      newNameInput?.select();
    });
    newNameInput?.addEventListener("input", () => {
      if (createButton) createButton.disabled = !newNameInput.value.trim();
    });
    clientPanel.querySelectorAll("[data-uniform-flag]").forEach(tile => {
      tile.addEventListener("click", event => {
        event.preventDefault();
        const flag = tile.dataset.uniformFlag;
        window.DFSquadController.uniformFlagDraft = Object.assign({ replaceClothing: false, exactMatches: false }, window.DFSquadController.uniformFlagDraft);
        window.DFSquadController.uniformFlagDraft[flag] = !window.DFSquadController.uniformFlagDraft[flag];
        window.renderSquadsPanel();
      });
    });
    clientPanel.querySelector("#uniformCreateBtn")?.addEventListener("click", async () => {
      const name = clientPanel.querySelector("#uniformNewName")?.value || "";
      try {
        const data = await uniformPost("uniform-create", name ? { name } : {});
        if (data && typeof data.id === "number") window.DFSquadController.uniformSelectedId = data.id;
        window.DFSquadController.squadStatusMsg = "Uniform template created.";
      } catch (err) { window.DFSquadController.squadStatusMsg = err.message || "Could not create template."; }
      await refreshAfterUniformEdit();
    });
    clientPanel.querySelector("#uniformRenameBtn")?.addEventListener("click", async () => {
      const name = clientPanel.querySelector("#uniformRenameInput")?.value || "";
      try {
        await uniformPost("uniform-rename", { id: window.DFSquadController.uniformSelectedId, name });
        window.DFSquadController.squadStatusMsg = "Template renamed.";
      } catch (err) { window.DFSquadController.squadStatusMsg = err.message || "Could not rename template."; }
      await refreshAfterUniformEdit();
    });
    clientPanel.querySelector("#uniformDeleteBtn")?.addEventListener("click", async () => {
      try {
        await uniformPost("uniform-delete", { id: window.DFSquadController.uniformSelectedId });
        window.DFSquadController.uniformSelectedId = -1;
        window.DFSquadController.squadStatusMsg = "Template deleted.";
      } catch (err) { window.DFSquadController.squadStatusMsg = err.message || "Could not delete template."; }
      await refreshAfterUniformEdit();
    });
    clientPanel.querySelector("#uniformFlagsBtn")?.addEventListener("click", async () => {
      const f = window.DFSquadController.uniformFlagDraft || {};
      const replaceClothing = f.replaceClothing ? 1 : 0;
      const exactMatches = f.exactMatches ? 1 : 0;
      try {
        await uniformPost("uniform-flags", { id: window.DFSquadController.uniformSelectedId, replaceClothing, exactMatches });
        window.DFSquadController.squadStatusMsg = "Flags saved.";
      } catch (err) { window.DFSquadController.squadStatusMsg = err.message || "Could not save flags."; }
      window.DFSquadController.uniformFlagDraft = null;
      await refreshAfterUniformEdit();
    });
    // The three add-item choosers are cyclers/segments/steppers now; the per-category draft holds
    // exactly what the three `select` + numeric DOM controls held, and Add POSTs the same six params.
    clientPanel.querySelectorAll("[data-uitem-choice]").forEach(seg => {
      seg.addEventListener("click", () => {
        const cat = Number(seg.closest(".squad-uitem-add")?.dataset.ucat);
        window.DFSquadController.uitemDrafts[cat] = Object.assign({}, window.DFSquadController.uitemDrafts[cat], { choice: Number(seg.dataset.uitemChoice) });
        window.renderSquadsPanel();
      });
    });
    clientPanel.querySelectorAll("[data-uitem-color]").forEach(input => {
      input.addEventListener("input", () => {
        const cat = Number(input.dataset.uitemColor);
        window.DFSquadController.uitemDrafts[cat] = Object.assign({}, window.DFSquadController.uitemDrafts[cat], { color: Number(input.value) });
      });
    });
    clientPanel.querySelectorAll("[data-uitem-add]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const cat = Number(btn.dataset.uitemAdd);
        const box = clientPanel.querySelector(`.squad-uitem-add[data-ucat="${cat}"]`);
        const colorInput = box && box.querySelector(".squad-uitem-color-input");
        const matOptions = sqMaterialClassOptions(window.DFSquadController.uniformCatalog, -1);
        const d = window.DFSquadController.uitemDrafts[cat] || {};
        const subtype = Number(d.subtype ?? -1);
        const matclass = Number(d.matclass ?? (matOptions.length ? matOptions[0][0] : -1));
        const color = Number(colorInput ? colorInput.value : (d.color ?? -1));
        const choice = cat === 6 ? Number(d.choice ?? 0) : 0;
        try {
          await uniformPost("uniform-item-add", { id: window.DFSquadController.uniformSelectedId, cat, subtype, matclass, color, choice });
          window.DFSquadController.squadStatusMsg = "Item added.";
        } catch (err) { window.DFSquadController.squadStatusMsg = err.message || "Could not add item."; }
        delete window.DFSquadController.uitemDrafts[cat];
        await refreshAfterUniformEdit();
      });
    });
    clientPanel.querySelectorAll(".squad-uitem-remove").forEach(btn => {
      btn.addEventListener("click", async () => {
        const cat = Number(btn.dataset.ucat);
        const index = Number(btn.dataset.uindex);
        try {
          await uniformPost("uniform-item-remove", { id: window.DFSquadController.uniformSelectedId, cat, index });
          window.DFSquadController.squadStatusMsg = "Item removed.";
        } catch (err) { window.DFSquadController.squadStatusMsg = err.message || "Could not remove item."; }
        await refreshAfterUniformEdit();
      });
    });
  }

  window.sqEquipView = sqEquipView;
  window.sqUniformAssignRows = sqUniformAssignRows;
  window.sqUniformEditor = sqUniformEditor;
  window.sqAmmoSection = sqAmmoSection;
  window.sqSuppliesSection = sqSuppliesSection;
  window.sqEquipmentDetails = sqEquipmentDetails;
  window.sqEquipmentPickerView = sqEquipmentPickerView;
  window.sqMaterialClassOptions = sqMaterialClassOptions;
  window.wireSquadUniformControls = wireSquadUniformControls;
  window.wireSquadEquipmentControls = wireSquadEquipmentControls;
  window.wireSquadAmmoControls = wireSquadAmmoControls;
  window.uniformPost = uniformPost;
  window.wireUniformEditorControls = wireUniformEditorControls;
