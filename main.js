const {
  Plugin,
  TFile,
  Modal,
  Setting,
  Notice,
  TextComponent,
  ButtonComponent,
  PluginSettingTab,
} = require("obsidian");

class AutoFrontmatterPlugin extends Plugin {
  async onload() {
    this.DEFAULT_SETTINGS = { rules: [] };
    await this.loadSettings();

    // Apply on file moves/renames and new file creation
    this.registerEvent(
      this.app.vault.on("rename", async (file, oldPath) => {
        if (file instanceof TFile && file.extension === "md") {
          await this.applyRules(file);
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on("create", async (file) => {
        if (file instanceof TFile && file.extension === "md") {
          await this.applyRules(file);
        }
      }),
    );

    // Optional command: apply to current file manually
    this.addCommand({
      id: "auto-fm-apply-current",
      name: "Apply rules to current file",
      callback: async () => {
        const file = this.app.workspace.getActiveFile();
        if (file && file.extension === "md") {
          await this.applyRules(file);
          new Notice("Auto Frontmatter: rules applied to current file.");
        } else {
          new Notice("No markdown file active.");
        }
      },
    });

    // Optional command: apply to all files (can be heavy on big vaults)
    this.addCommand({
      id: "auto-fm-apply-all",
      name: "Apply rules to all markdown files",
      callback: async () => {
        const files = this.app.vault.getMarkdownFiles();
        for (const f of files) {
          await this.applyRules(f);
        }
        new Notice(`Auto Frontmatter: rules applied to ${files.length} files.`);
      },
    });

    this.addSettingTab(new AutoFMSettingTab(this.app, this));
  }

  onunload() {}

  async loadSettings() {
    const saved = await this.loadData();
    this.settings = Object.assign({}, this.DEFAULT_SETTINGS, saved);
    if (!Array.isArray(this.settings.rules)) this.settings.rules = [];
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ------- Core: Apply rules to a file if its path matches any rule folder -------
  async applyRules(file) {
    const path = file.path.replace(/\\/g, "/");
    const matchingRules = this.settings.rules.filter((r) =>
      this.isFileInFolder(path, r.folder),
    );

    if (matchingRules.length === 0) return;

    const fileContent = await this.app.vault.read(file);
    const { frontmatter, body, hadFM, originalFMText } =
      parseFrontmatter(fileContent);

    // Collect all keys that will be modified by rules
    const keysToModify = new Set();
    const newValues = {};

    // Merge all rule frontmatters (accumulate)
    for (const rule of matchingRules) {
      for (const k in rule.frontmatter) {
        keysToModify.add(k);
        const incoming = rule.frontmatter[k];

        if (Array.isArray(incoming)) {
          const existing = toArray(frontmatter[k]);
          for (const val of incoming) {
            if (!existing.includes(val)) existing.push(val);
          }
          newValues[k] = existing;
        } else {
          // scalar: last wins by default? For "accumulate" feel, if key already an array, push; else set.
          // But for your case, you want tags to accumulate, and type to update to the latest folder's value.
          if (k === "tags" || k === "tag" || k === "keywords") {
            const existing = toArray(frontmatter[k]);
            if (!existing.includes(incoming)) existing.push(incoming);
            newValues[k] = existing;
          } else {
            // Update scalar
            newValues[k] = incoming;
          }
        }
      }
    }

    // Check if frontmatter actually needs to be changed
    let needsUpdate = false;
    for (const [key, newValue] of Object.entries(newValues)) {
      const currentValue = frontmatter[key];

      if (Array.isArray(newValue) && Array.isArray(currentValue)) {
        // Compare arrays
        if (
          newValue.length !== currentValue.length ||
          !newValue.every((val) => currentValue.includes(val))
        ) {
          needsUpdate = true;
          break;
        }
      } else if (newValue !== currentValue) {
        needsUpdate = true;
        break;
      }
    }

    if (!needsUpdate) {
      return;
    }

    // Apply surgical frontmatter modification
    const modifiedFMText = modifyFrontmatterSelectively(
      originalFMText,
      newValues,
      hadFM,
    );

    // Handle spacing between frontmatter and body carefully
    // Remove the trailing newline from modifiedFMText and add exactly one
    const cleanFM = modifiedFMText.replace(/\n$/, "");
    const newContent = cleanFM + "\n" + body;

    await this.app.vault.modify(file, newContent);
  }

  isFileInFolder(filePath, folder) {
    if (!folder) return false;
    const normFolder = folder.replace(/^\/+|\/+$/g, "").toLowerCase();
    if (normFolder === "") return false;
    const lastSlash = filePath.lastIndexOf('/');
    const dirPath = (lastSlash === -1) ? "" : filePath.substring(0, lastSlash);
    const searchIn = '/' + dirPath.toLowerCase() + '/';
    const searchFor = '/' + normFolder + '/';
    return searchIn.includes(searchFor);
  }
}

/* ----------------------------- Utilities ----------------------------- */



function toArray(val) {
  if (val == null) return [];
  if (Array.isArray(val)) {
    return val.filter(
      (item) =>
        item !== null && item !== undefined && String(item).trim() !== "",
    );
  }
  const stringVal = String(val).trim();
  return stringVal !== "" ? [stringVal] : [];
}

// Very simple FM parser (YAML-ish). Handles arrays like [a, b] and simple scalars.
// Avoids external YAML to keep it mobile-friendly.
function parseFrontmatter(text) {
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fmMatch) {
    return { frontmatter: {}, body: text, hadFM: false, originalFMText: "" };
  }
  const raw = fmMatch[1];
  const frontmatter = {};
  const body = text.slice(fmMatch[0].length);
  const originalFMText = fmMatch[0];

  const lines = raw.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const idx = line.indexOf(":");
    if (idx === -1) {
      i++;
      continue;
    }
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (!key) {
      i++;
      continue;
    }

    // Check if this is a YAML list (empty value followed by dash items)
    if (
      val === "" &&
      i + 1 < lines.length &&
      lines[i + 1].trim().startsWith("-")
    ) {
      const arr = [];
      i++; // Move to first dash line
      while (i < lines.length && lines[i].trim().startsWith("-")) {
        const item = lines[i].trim().slice(1).trim(); // Remove dash and trim
        if (item) arr.push(item);
        i++;
      }
      frontmatter[key] = arr;
      continue;
    }

    // Array in bracket format?
    if (val.startsWith("[") && val.endsWith("]")) {
      const inner = val.slice(1, -1).trim();
      const arr = inner
        ? inner
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s !== null && s !== undefined && s !== "")
        : [];
      frontmatter[key] = arr;
    } else {
      // Strip surrounding quotes if any
      val = val.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
      frontmatter[key] = val;
    }
    i++;
  }
  return { frontmatter, body, hadFM: true, originalFMText };
}

// Surgically modify only specified keys in frontmatter, preserving original formatting for others
function modifyFrontmatterSelectively(originalFMText, newValues, hadFM) {
  if (!hadFM) {
    // Create new frontmatter from scratch
    const lines = ["---"];
    for (const [k, v] of Object.entries(newValues)) {
      lines.push(formatFrontmatterLine(k, v));
    }
    lines.push("---");
    return lines.join("\n") + "\n";
  }

  // Parse original frontmatter line by line, preserving formatting
  const lines = originalFMText.split("\n");
  const modifiedLines = [];
  const processedKeys = new Set();
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line === "---") {
      modifiedLines.push(line);
      i++;
      continue;
    }

    const idx = line.indexOf(":");
    if (idx === -1) {
      modifiedLines.push(line);
      i++;
      continue;
    }

    const key = line.slice(0, idx).trim();
    if (!key) {
      modifiedLines.push(line);
      i++;
      continue;
    }

    if (newValues.hasOwnProperty(key)) {
      // Replace with new value
      modifiedLines.push(formatFrontmatterLine(key, newValues[key]));
      processedKeys.add(key);

      // Skip any YAML list items that follow this key
      const val = line.slice(idx + 1).trim();
      if (
        val === "" &&
        i + 1 < lines.length &&
        lines[i + 1].trim().startsWith("-")
      ) {
        i++; // Move to first dash line
        while (i < lines.length && lines[i].trim().startsWith("-")) {
          i++; // Skip all dash lines
        }
        continue;
      }
    } else {
      // Keep original line unchanged
      modifiedLines.push(line);
    }
    i++;
  }

  // Add any new keys that weren't in the original frontmatter
  const newKeys = Object.keys(newValues).filter((k) => !processedKeys.has(k));
  if (newKeys.length > 0) {
    // Insert before the closing "---"
    const lastDashIndex = modifiedLines.lastIndexOf("---");
    for (const key of newKeys) {
      modifiedLines.splice(
        lastDashIndex,
        0,
        formatFrontmatterLine(key, newValues[key]),
      );
    }
  }

  return modifiedLines.join("\n") + "\n";
}

// Format a single frontmatter key-value pair
function formatFrontmatterLine(key, value) {
  if (Array.isArray(value)) {
    const filteredArray = value.filter(
      (item) =>
        item !== null && item !== undefined && String(item).trim() !== "",
    );
    return `${key}: [${filteredArray.join(", ")}]`;
  } else {
    const str = String(value);
    const needsQuote =
      /^\s|\s$/.test(str) || // leading/trailing spaces
      /\n/.test(str) || // contains newlines
      str.startsWith("[") || // starts with bracket
      (str.includes(":") &&
        !/^\d{4}-\d{2}-\d{2}(\s+\d{1,2}:\d{2}(:\d{2})?)?$/.test(str)); // has colon but isn't a date/time
    return `${key}: ${needsQuote ? `"${str}"` : str}`;
  }
}

function stringifyFrontmatter(obj) {
  const lines = ["---"];
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) {
      // Filter out empty values from array
      const filteredArray = v.filter(
        (item) =>
          item !== null && item !== undefined && String(item).trim() !== "",
      );
      lines.push(`${k}: [${filteredArray.join(", ")}]`);
    } else {
      // quote if starts with '[', contains newlines, or has leading/trailing spaces
      // but don't quote common date/time formats or simple values with colons
      const str = String(v);
      const needsQuote =
        /^\s|\s$/.test(str) || // leading/trailing spaces
        /\n/.test(str) || // contains newlines
        str.startsWith("[") || // starts with bracket
        (str.includes(":") &&
          !/^\d{4}-\d{2}-\d{2}(\s+\d{1,2}:\d{2}(:\d{2})?)?$/.test(str)); // has colon but isn't a date/time
      lines.push(`${k}: ${needsQuote ? `"${String(v)}"` : v}`);
    }
  }
  lines.push("---");
  return lines.join("\n") + "\n";
}

/* --------------------------- Settings UI ---------------------------- */

class AutoFMSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("hot-folder-settings");

    // Header
    containerEl.createEl("h1", { text: "Hot Folder" });

    // Description
    const desc = containerEl.createEl("div", {
      cls: "setting-item-description",
    });
    desc.setText(
      "Automatically add frontmatter to notes based on their folder location. When a note is created or moved into a matching folder, the specified frontmatter will be merged into the note.",
    );

    // Empty state
    if (this.plugin.settings.rules.length === 0) {
      const empty = containerEl.createDiv("hot-folder-empty-state");
      empty.createEl("div", { text: "No rules configured" });
      empty.createEl("div", {
        cls: "setting-item-description",
        text: "Add your first rule to automatically apply frontmatter based on folder paths.",
      });
    }

    // List existing rules
    this.plugin.settings.rules.forEach((rule, index) => {
      const setting = new Setting(containerEl).setClass(
        "hot-folder-rule-setting",
      );

      // Rule header with folder name
      const header = setting.nameEl.createDiv("hot-folder-rule-header");
      header.createSpan({ text: "Folder: " });
      header.createSpan({
        cls: "hot-folder-folder-badge hot-folder-mono",
        text: rule.folder || "(not set)",
      });

      // Display frontmatter fields
      if (rule.frontmatter && Object.keys(rule.frontmatter).length > 0) {
        const fieldsGrid = setting.descEl.createDiv("hot-folder-fields-grid");

        for (const [key, value] of Object.entries(rule.frontmatter)) {
          const fieldItem = fieldsGrid.createDiv("hot-folder-field-item");
          const fieldKey = fieldItem.createDiv("hot-folder-field-key");
          fieldKey.setText(key);

          const fieldValue = fieldItem.createDiv("hot-folder-field-value");

          if (Array.isArray(value)) {
            fieldValue.setText(value.join(", "));
          } else {
            fieldValue.setText(String(value));
          }
        }
      } else {
        setting.setDesc("No frontmatter fields defined");
      }

      // Edit button
      setting.addButton((btn) =>
        btn
          .setButtonText("Edit")
          .setTooltip("Edit this rule")
          .onClick(async () => {
            const modal = new RuleEditModal(
              this.app,
              rule,
              async (updatedRule) => {
                this.plugin.settings.rules[index] = updatedRule;
                await this.plugin.saveSettings();
                this.display();
              },
            );
            modal.open();
          }),
      );

      // Delete button
      setting.addButton((btn) =>
        btn
          .setButtonText("Delete")
          .setWarning()
          .setTooltip("Delete this rule")
          .onClick(async () => {
            this.plugin.settings.rules.splice(index, 1);
            await this.plugin.saveSettings();
            this.display();
          }),
      );
    });

    // Add new rule
    new Setting(containerEl)
      .setName("Add new rule")
      .setDesc("Create a new folder → frontmatter rule")
      .addButton((btn) =>
        btn
          .setButtonText("Add rule")
          .setCta()
          .onClick(async () => {
            const newRule = {
              folder: "",
              frontmatter: {},
            };
            const modal = new RuleEditModal(
              this.app,
              newRule,
              async (finalRule) => {
                this.plugin.settings.rules.push(finalRule);
                await this.plugin.saveSettings();
                this.display();
              },
              true,
            );
            modal.open();
          }),
      );
  }
}

/* ----------------------------- Edit Modal ----------------------------- */

class RuleEditModal extends Modal {
  // onSave: (rule) => void
  // if creating, we can prefill a default rule
  constructor(app, rule, onSave, isNew = false) {
    super(app);
    this.rule = deepClone(rule || { folder: "", frontmatter: {} });
    this.onSave = onSave;
    this.isNew = isNew;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    // Header
    contentEl.createEl("h2", {
      text: this.isNew ? "Add new rule" : "Edit rule",
    });

    // Folder path setting
    new Setting(contentEl)
      .setName("Folder path")
      .setDesc(
        "The folder path to match (e.g., 'People/Authors' or 'Projects'). Matching is prefix-based.",
      )
      .addText((text) =>
        text
          .setPlaceholder("folder/subfolder")
          .setValue(this.rule.folder || "")
          .onChange((value) => {
            this.rule.folder = (value || "").replace(/^\/+|\/+$/g, "");
          }),
      );

    // Frontmatter fields header
    const frontmatterSetting = new Setting(contentEl)
      .setName("Frontmatter fields")
      .setDesc(
        "Define the properties to add to notes in this folder. Use commas for multiple values (e.g., 'work, project').",
      )
      .setHeading();

    // Key-Value editor container
    this.kvContainer = contentEl.createDiv();
    this.renderKVRows();

    // Add field button
    new Setting(contentEl).addButton((btn) =>
      btn.setButtonText("Add field").onClick(() => {
        if (!this.rule.frontmatter) this.rule.frontmatter = {};
        this.rule.frontmatter["key"] = "";
        this.renderKVRows();
      }),
    );

    // Footer buttons
    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText("Cancel").onClick(() => this.close()),
      )
      .addButton((btn) =>
        btn
          .setButtonText(this.isNew ? "Create rule" : "Save changes")
          .setCta()
          .onClick(() => {
            // Clean up frontmatter
            const cleaned = {};
            for (const [k, v] of Object.entries(this.rule.frontmatter || {})) {
              const key = String(k).trim();
              if (!key) continue;
              if (Array.isArray(v)) {
                const arr = v.map((x) => String(x).trim()).filter(Boolean);
                if (arr.length > 0) cleaned[key] = arr;
              } else {
                const value = String(v).trim();
                if (value) cleaned[key] = value;
              }
            }
            this.rule.frontmatter = cleaned;
            if (!this.rule.folder || !this.rule.folder.trim()) {
              new Notice("Folder path is required.");
              return;
            }
            this.close();
            this.onSave && this.onSave(deepClone(this.rule));
          }),
      );
  }

  renderKVRows() {
    this.kvContainer.empty();
    if (!this.rule.frontmatter) this.rule.frontmatter = {};

    Object.entries(this.rule.frontmatter).forEach(([key, value]) => {
      const setting = new Setting(this.kvContainer);

      // Key input
      setting.addText((text) => {
        text
          .setPlaceholder("Field name (e.g., tags, type, category)")
          .setValue(key)
          .onChange((newKey) => {
            if (newKey !== key) {
              const cur = this.rule.frontmatter[key];
              delete this.rule.frontmatter[key];
              this.rule.frontmatter[newKey] = cur;
              key = newKey;
            }
          });
      });

      // Value input with smart detection
      setting.addText((text) => {
        const isArray = Array.isArray(value);
        const initialValue = isArray ? value.join(", ") : String(value ?? "");

        text
          .setPlaceholder("Field value (use commas for multiple values)")
          .setValue(initialValue)
          .onChange((inputValue) => {
            const trimmed = inputValue.trim();

            // Auto-detect: if contains commas, treat as array
            if (trimmed.includes(",")) {
              this.rule.frontmatter[key] = trimmed
                .split(",")
                .map((x) => x.trim())
                .filter(Boolean);
            } else {
              // Single value, treat as string
              this.rule.frontmatter[key] = trimmed;
            }
          });
      });

      // Remove button
      setting.addButton((btn) =>
        btn
          .setButtonText("Remove")
          .setWarning()
          .onClick(() => {
            delete this.rule.frontmatter[key];
            this.renderKVRows();
          }),
      );
    });

    // Empty state
    if (Object.keys(this.rule.frontmatter).length === 0) {
      const emptySetting = new Setting(this.kvContainer);
      emptySetting.setDesc(
        "No fields defined. Click 'Add field' above to get started.",
      );
      emptySetting.descEl.style.textAlign = "center";
      emptySetting.descEl.style.fontStyle = "italic";
      emptySetting.descEl.style.color = "var(--text-muted)";
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

/* ----------------------------- helpers ----------------------------- */

function deepClone(x) {
  return JSON.parse(JSON.stringify(x));
}

module.exports = AutoFrontmatterPlugin;
