let files = {};      // { filename: content }
let fileList = [];
let editingConstraintName = null; // The name of the constraint currently being edited（nullIndicates new）
let currentIndex = -1;

const dropZone = document.getElementById("drop-zone");
const promptBox = document.getElementById("prompt");
const dependBox = document.getElementById("depend");
const suggestionList = document.getElementById("suggestion-list");
const createFileModal = document.getElementById("create-file-modal");

const defaultSettings = {
  maxTotalStorageKB: 2000,
  autoCleanupEnabled: true,
  maxFileAgeDays: 30,
  maxFileSizeKB: 500,
  maxFilesCount: 20,
  maxConstraintWords: 1000,
  maxConstraintsCount: 10,
  autoCleanupPromptEnabled: true,
  maxPromptAgeDays: 7, // prompt Cache time is usually shorter than file
  maxPromptKB: 200
};

const maxPromptAge = getSetting('maxPromptAgeDays') * 24 * 60 * 60 * 1000;

// 🔹 Restore on page load
window.addEventListener("DOMContentLoaded", () => {
  const savedFiles = localStorage.getItem("ai_paste_files");
  const savedFileList = localStorage.getItem("ai_paste_fileList");

  if (savedFiles) files = JSON.parse(savedFiles);
  if (savedFileList) fileList = JSON.parse(savedFileList);
  
  initPromptBox()
  initDependBox()

  // Initialize file timestamps and automatic cleanup
  initFileTimestamps();
  if (getSetting('autoCleanupEnabled')) {
    const cleanedCount = autoCleanupFiles();
    if (cleanedCount > 0) {
      console.log(`Auto cleaned ${cleanedCount} expired files`);
    }

  resetStatusToDefault();
  }
  
  updateFileList();
});

function initPromptBox() {
  // examine prompt Is it expired?
  const savedPrompt = localStorage.getItem("ai_paste_prompt");
  const savedPromptTimestamp = localStorage.getItem("ai_paste_promptTimestamp");
  const promptAge = savedPromptTimestamp ? Date.now() - parseInt(savedPromptTimestamp) : Infinity;
  
  if (savedPrompt && promptAge <= maxPromptAge) {
    promptBox.innerHTML = savedPrompt;
  } else if (savedPromptTimestamp && promptAge > maxPromptAge) {
    // prompt Expired，clean up
    localStorage.removeItem("ai_paste_prompt");
    localStorage.removeItem("ai_paste_promptTimestamp");
    promptBox.innerHTML = "";
    console.log("Cleaned expired prompt");
  } else {
    promptBox.innerHTML = "";
  }

  if (!promptBox.innerHTML.trim()) {
    promptBox.innerHTML = `<div style="color: #666; font-style: italic;">
Task objective goes here. You can reference files using @filename tokens.
</div>`;
    
    // Clear sample text on click
    promptBox.addEventListener('focus', function clearExample() {
      if (this.innerHTML.includes('Task objective goes here')) {
        this.innerHTML = '';
      }
      this.removeEventListener('focus', clearExample);
    });
  }
}

function initDependBox() {
  // New：initializationDependPanel content
  const savedDepend = localStorage.getItem("ai_paste_depend");
  const savedDependTimestamp = localStorage.getItem("ai_paste_dependTimestamp");
  
  if (savedDepend) {
    const dependAge = savedDependTimestamp ? Date.now() - parseInt(savedDependTimestamp) : Infinity;
    const maxDependAge = getSetting('maxPromptAgeDays') * 24 * 60 * 60 * 1000;
    
    if (dependAge <= maxDependAge) {
      document.getElementById("depend").innerHTML = savedDepend;
    } else {
      localStorage.removeItem("ai_paste_depend");
      localStorage.removeItem("ai_paste_dependTimestamp");
      document.getElementById("depend").innerHTML = "";
    }
  }
  if (!dependBox.innerHTML.trim()) {
    dependBox.innerHTML = `<div style="color: #666; font-style: italic;">
Example format:
- main.py (target)
    - depends on utils.py
    - should follow structure of main-bk.py
- utils.py (reference)
    - contains helper functions
</div>`;
    
    // Clear sample text on click
    dependBox.addEventListener('focus', function clearExample() {
      if (this.innerHTML.includes('Example format')) {
        this.innerHTML = '';
      }
      this.removeEventListener('focus', clearExample);
    });
  }
}

// Create File Button click event
document.getElementById("create-file-btn").addEventListener("click", () => {
  document.getElementById("new-filename").value = "";
  document.getElementById("new-filecontent").value = "";
  createFileModal.classList.remove("hidden");
});

// Cancel button
document.getElementById("cancel-new-file").addEventListener("click", () => {
  createFileModal.classList.add("hidden");
});

// Save button
document.getElementById("save-new-file").addEventListener("click", async () => {
  const filename = document.getElementById("new-filename").value.trim();
  const desc = document.getElementById("new-filedesc").value.trim();
  const content = document.getElementById("new-filecontent").value;
  
  if (!filename) {
    showStatus("File name can not be empty", false);
    return;
  }
  
  const checkResult = checkStorageLimits(content, filename, false);
  
  if (!checkResult.isValid) {
    showStatus(`Saving failed: ${checkResult.errors.join('; ')}`, false);
    return;
  }
  
  if (files[filename]) {
    const overwrite = await showConfirmModal(`File "${filename}" already exists. Replace it?`);
    if (!overwrite) {
        return; // User cancels → Do not replace
    }
  }

  // Show warning
  if (checkResult.warnings.length > 0) {
    showStatus(`Warning: ${checkResult.warnings.join('; ')}`, 'warning');
  }
  
    files[filename] = {
    content: content,
    desc: desc || "",       // Default empty
    time: Date.now()
  };

  if (!fileList.includes(filename)) {
    fileList.push(filename);
  }
  
  updateFileList();
  createFileModal.classList.add("hidden");
  showStatus(`File ${filename} created`, true);
});


document.getElementById("copy-btn").addEventListener("click", async () => {
  // 1. Extract using new functiontask（Contains only filename references）
  const mainTask = extractFileReferences(promptBox);
  
  // 2. Extract using new functiondependencies（Contains only filename references）
  const dependencies = extractFileReferences(dependBox);
  
  // 3. collect alltokenReferenced file content
  const fileContents = collectAllFileContents(promptBox, dependBox);

  // 4. Collection constraints（keep it the same way）
  const constraints = collectConstraints();
  
  // 5. Assemble according to template
  const finalText = buildTemplate({
    task: mainTask,
    dependencies: dependencies,
    constraints: constraints,
    files: fileContents
  });
  
  // 5. copy to clipboard（original logic）
  try {
    await navigator.clipboard.writeText(finalText);
    showStatus("Prompt copied with template!", true);
    saveCurrentPrompt();
    saveCurrentDepend();
  } catch (err) {
    console.error("Copy failed:", err);
    showStatus("Copy failed, please copy manually.", false);
  }
});

// ----------------- Drag and drop files（Same as before） -----------------
dropZone.addEventListener("dragover", e => {
  e.preventDefault();
  dropZone.style.borderColor = "#333";
});
dropZone.addEventListener("dragleave", () => dropZone.style.borderColor = "#888");
dropZone.addEventListener("drop", e => {
  e.preventDefault();
  e.stopPropagation();
  dropZone.style.borderColor = "#888";
  const droppedFiles = e.dataTransfer.files;
  for (let f of droppedFiles) {
    const reader = new FileReader();
    reader.onload = () => {
      const content = reader.result;
      const checkResult = checkStorageLimits(content, f.name, false);
      
      if (!checkResult.isValid) {
        showStatus(`Failed to add ${checkResult.errors.join('; ')}`, false);
        return;
      }
      
      if (files[f.name]) {
        const overwrite = confirm(`File "${filename}" already exists. Replace it?`);
        if (!overwrite) {
            return; // User cancels → Do not replace
        }
      }

      // Show warning
      if (checkResult.warnings.length > 0) {
        showStatus(`Warning: ${checkResult.warnings.join('; ')}`, 'warning');
      }
      
      files[f.name] = {
        content: content,
        desc: "",       // Default empty
        deps: [],
        time: Date.now()
      };

      if (!fileList.includes(f.name)) fileList.push(f.name);
      updateFileTimestamp(f.name); // For drag and drop files
      updateFileList();
      showStatus(`Added ${f.name}`, true);
    };
    reader.readAsText(f);
  }
});

promptBox.addEventListener("mouseup", saveCurrentPrompt);
promptBox.addEventListener("keyup", function(e) {
  handleEditorKeyup(e, promptBox);
});
promptBox.addEventListener("keydown", function(e) {
  handleEditorKeydown(e, promptBox);
});
promptBox.addEventListener('blur', () => {
  // Save immediately when out of focus
  saveCurrentDepend();
  saveCurrentPrompt();
});

dependBox.addEventListener("mouseup", saveCurrentDepend);
dependBox.addEventListener("keyup", function(e) {
  handleEditorKeyup(e, dependBox);
});
dependBox.addEventListener("keydown", function(e) {
  handleEditorKeydown(e, dependBox);
});
dependBox.addEventListener('blur', () => {
  // Save immediately when out of focus
  saveCurrentDepend();
  saveCurrentPrompt();
});

// Initialization file timestamp
function initFileTimestamps() {
  if (!localStorage.getItem("ai_paste_fileTimestamps")) {
    const timestamps = {};
    fileList.forEach(filename => {
      timestamps[filename] = Date.now();
    });
    localStorage.setItem("ai_paste_fileTimestamps", JSON.stringify(timestamps));
  }
}

// Update file timestamp（Adding/Called when a file is modified）
function updateFileTimestamp(filename) {
  const timestamps = JSON.parse(localStorage.getItem("ai_paste_fileTimestamps") || "{}");
  timestamps[filename] = Date.now();
  localStorage.setItem("ai_paste_fileTimestamps", JSON.stringify(timestamps));
}

// Storage check utility function
function checkStorageLimits(newFileContent = '', newFileName = '', isCommand = false) {
  const settings = {...defaultSettings, ...loadSettings()};
  const errors = [];
  const warnings = [];
  
  if (!isCommand) {
    // File size check
    if (newFileContent.length > settings.maxFileSizeKB * 1024) {
      errors.push(`File size exceeds limit: ${(newFileContent.length/1024).toFixed(1)}KB > ${settings.maxFileSizeKB}KB`);
    }
    
    // File quantity check
    const willExceedCount = !files[newFileName] && fileList.length >= settings.maxFilesCount;
    if (willExceedCount) {
      errors.push(`The number of files reached the upper limit: ${settings.maxFilesCount}`);
    }
  } else {
    // Command length check (by number of words)
    const wordCount = newFileContent.trim().split(/\s+/).length;
    if (wordCount > settings.maxConstraintWords) {
      errors.push(`Command length exceeds limit: ${wordCount} words > ${settings.maxConstraintWords} words`);
    }
    
    // Command number check
    const commandCount = Object.keys(customCmds).length;
    const willExceedCommands = !customCmds[newFileName] && commandCount >= settings.maxConstraintsCount;
    if (willExceedCommands) {
      errors.push(`The number of commands reaches the upper limit: ${settings.maxConstraintsCount}`);
    }
  }
  
  // Total storage space check
  const currentTotal = Object.values(files).reduce((sum, content) => sum + content.length, 0);
  const currentSize = files[newFileName] ? files[newFileName].length : 0;
  const newTotal = currentTotal + newFileContent.length - currentSize;
  
  if (newTotal > settings.maxTotalStorageKB * 1024) {
    errors.push(`Insufficient total storage space: ${(newTotal/1024).toFixed(1)}KB > ${settings.maxTotalStorageKB}KB`);
  }
  
  // warning check (Exceed80%)
  const usagePercent = (newTotal / (settings.maxTotalStorageKB * 1024)) * 100;
  if (usagePercent > 80) {
    warnings.push(`Storage space usage: ${usagePercent.toFixed(1)}%`);
  }
  
  return { isValid: errors.length === 0, errors, warnings };
}

function handleEditorKeyup(e, editor) {

  saveSelectionRange(editor);

  if (e.key === "@") {
    showSuggestionListFor(editor, true);
  } else if (
    e.key.length === 1 ||
    e.key === "Backspace" ||
    e.key === "Delete"
  ) {
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const r = sel.getRangeAt(0);
      const prefix = getTextBeforeCaret(r, 30, editor);
      const match = prefix.match(/@([^\s]*)$/);
      if (match) {
        showSuggestionListFor(editor, false, match[1]);
      } else {
        hideSuggestionListFor(editor);
      }
    }
  }
}

function handleEditorKeydown(e, editor) {
  const suggestionList = editor === promptBox ? 
    document.getElementById("suggestion-list") : 
    document.getElementById("depend-suggestion-list");
    
  if (suggestionList.classList.contains("hidden")) return;
  
  const items = suggestionList.querySelectorAll("li");
  if (items.length === 0) return;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    currentIndex = (currentIndex + 1) % items.length;
    highlightSuggestionItem(suggestionList);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    currentIndex = (currentIndex - 1 + items.length) % items.length;
    highlightSuggestionItem(suggestionList);
  } else if (e.key === "Enter") {
    if (currentIndex >= 0 && currentIndex < items.length) {
      e.preventDefault();
      if (editor === promptBox) {
        restorePromptSelection()
      } else {
        restoreDependSelection()
      }
      const li = items[currentIndex];
      if (li.dataset.type === "file") {
        insertFileToken(li.dataset.filename, editor);
      } else if (li.dataset.type === "cmd") {
        insertCmdToken(li.dataset.filename, editor);
      }
      hideSuggestionListFor(editor);
    }
  }
}

function getTextBeforeCaret(range, maxChars, container) {
  try {
    const r = range.cloneRange();
    r.collapse(true);
    r.setStart(container, 0);
    let txt = r.toString();
    if (txt.length > maxChars) txt = txt.slice(-maxChars);
    return txt;
  } catch (err) {
    return "";
  }
}

// ----------------- insert token -----------------
function insertCmdToken(cmdKey, editor) {
  if (editor === promptBox) {
    restorePromptSelection()
  } else {
    restoreDependSelection()
  }
  removePrecedingAtChar(editor);

  const token = document.createElement("span");
  token.className = "cmd-token";
  token.setAttribute("data-cmd", cmdKey);
  token.contentEditable = "false";
  token.innerHTML = `<svg viewBox="0 0 16 16" width="12" height="12" style="vertical-align:middle;margin-right:4px;">
    <circle cx="8" cy="8" r="8" fill="#8bc34a"></circle>
  </svg>${cmdKey}`;

  const sel = window.getSelection();
  let range;
  if (sel && sel.rangeCount > 0) range = sel.getRangeAt(0);
  else range = document.createRange();

  range.deleteContents();
  range.insertNode(token);

  const afterSpace = document.createTextNode("\u00A0");
  token.parentNode.insertBefore(afterSpace, token.nextSibling);

  const newRange = document.createRange();
  newRange.setStartAfter(afterSpace);
  newRange.collapse(true);
  sel.removeAllRanges();
  sel.addRange(newRange);

  saveSelectionRange(editor);
}

// ----------------- insert token -----------------
function insertFileToken(filename, editor) {
  if (editor === promptBox) {
    restorePromptSelection()
  } else {
    restoreDependSelection()
  }
  removePrecedingAtChar(editor);

  const token = document.createElement("span");
  token.className = "file-token";
  token.setAttribute("data-filename", filename);
  token.contentEditable = "false";
  token.innerHTML = `<svg viewBox="0 0 16 16" width="12" height="12" style="vertical-align:middle;margin-right:4px;">
    <rect width="16" height="16" fill="#bbb"></rect>
  </svg>${filename}`;

  const sel = window.getSelection();
  let range;
  if (sel && sel.rangeCount > 0) range = sel.getRangeAt(0);
  else range = document.createRange();

  range.deleteContents();
  range.insertNode(token);

  const afterSpace = document.createTextNode("\u00A0");
  token.parentNode.insertBefore(afterSpace, token.nextSibling);

  const newRange = document.createRange();
  newRange.setStartAfter(afterSpace);
  newRange.collapse(true);
  sel.removeAllRanges();
  sel.addRange(newRange);

  saveSelectionRange(editor);
}

function removePrecedingAtChar(editor) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  const sc = range.startContainer;
  const offset = range.startOffset;
  
  // Make sure we are operating on the contents of the current editor
  if (sc.nodeType === Node.TEXT_NODE && 
      editor.contains(sc) && 
      offset > 0 && 
      sc.data[offset-1] === "@") {
    
    sc.deleteData(offset-1, 1);
    const newRange = document.createRange();
    newRange.setStart(sc, offset-1);
    newRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(newRange);
  }
}

// ----------------- Copy button -----------------
function showStatus(msg, status = 'default') {
  const statusEl = document.getElementById("copy-status");
  
  // clear timer
  clearTimeout(statusEl._timer);
  
  if (msg) {
    let icon, background, border, textColor;
    
    switch(status) {
      case true: // success
        icon = '✓';
        background = '#e8f5e9';
        border = '1px solid #c8e6c9';
        textColor = '#388e3c';
        break;
      case false: // mistake
        icon = '✗';
        background = '#ffebee';
        border = '1px solid #ffcdd2';
        textColor = '#d32f2f';
        break;
      case 'warning': // warn
        icon = '⚠';
        background = '#fff3e0';
        border = '1px solid #ffcc80';
        textColor = '#ff9800';
        break;
      default: // default
        icon = '🔍';
        background = '#ebf8ff';
        border = '1px solid #bee3f8';
        textColor = '#222';
    }
    
    statusEl.innerHTML = `<span style="color:${textColor};font-weight:bold;">${icon}</span> <span style="color:#222;">${msg}</span>`;
    statusEl.style.background = background;
    statusEl.style.border = border;
    statusEl.style.borderRadius = "6px";
    statusEl.style.padding = "4px 12px";
    
    // Set timer
    const timeout = status === 'warning' ? 4000 : 2000;
    statusEl._timer = setTimeout(() => { 
      resetStatusToDefault();
    }, timeout);
  } else {
    resetStatusToDefault();
  }
}

// New：Function to reset to default state
function resetStatusToDefault() {
  const status = document.getElementById("copy-status");
  status.innerHTML = `
    <span class="status-default">
      <span class="status-icon">🔍</span>
      <span class="status-text">What are you up to?
    </span>
  `;
  status.style.background = '#ebf8ff';
  status.style.border = '1px solid #bee3f8';
  status.style.borderRadius = "6px";
  status.style.padding = "4px 12px";
}

function updateFileList() {
  const fileListDiv = document.getElementById("file-list");
  if (fileList.length === 0) {
    fileListDiv.textContent = "(No files in the list)";
  } else {
    fileListDiv.innerHTML = fileList.map(name => `
      <div class="file-item" draggable="true" data-filename="${name}">
        <a href="#" class="file-link" data-fname="${name}">
          ${shortenFileName(name)}
        </a>
        ${files[name].desc ? "" : `
          <span class="missing-desc" 
            style="color:red;cursor:help;margin-left:4px;"
            title="The file is missingdescription，Click on the file name to adddescription">！
          </span>`}
          <span>${formatFileSize(files[name].content)}</span>
        <span class="delete-file" style="cursor:pointer;color:red;margin-left:5px;">x</span>
      </div>
    `).join("");
  }

  // 🔹 save to localStorage
  localStorage.setItem("ai_paste_files", JSON.stringify(files));
  localStorage.setItem("ai_paste_fileList", JSON.stringify(fileList));

  document.querySelectorAll(".file-link").forEach(a => {
    a.addEventListener("click", (e) => {
        e.preventDefault();
        const fname = a.dataset.fname;
        openEditFileModal(fname);
    });
  });

}

function openEditFileModal(fname) {
    const modal = document.getElementById("create-file-modal");
    modal.classList.remove("hidden");

    document.getElementById("new-filename").value = fname;
    //document.getElementById("new-filename").disabled = true; // Name change not allowed

    document.getElementById("new-filedesc").value = files[fname].desc || "";
    document.getElementById("new-filecontent").value = files[fname].content || "";

    // Modify title
    modal.querySelector("h3").innerText = "Edit File";
    
    // Change the save button to“renew”
    document.getElementById("save-new-file").onclick = function() {
        files[fname].desc = document.getElementById("new-filedesc").value.trim();
        files[fname].content = document.getElementById("new-filecontent").value;
        modal.classList.add("hidden");
        updateFileList();
    };
}

// --- Quick command management ---
let customCmds = JSON.parse(localStorage.getItem("ai_paste_cmds") || "{}");

// Open pop-up window
document.getElementById("customize-btn").onclick = function() {
  renderCmdTable();
  document.getElementById("customize-modal").classList.remove("hidden");
};

// Close pop-up window
document.getElementById("close-cmds").onclick = function() {
  document.getElementById("customize-modal").classList.add("hidden");
};

// Delete row
document.querySelector("#cmd-table tbody").onclick = function(e) {
  if (e.target.classList.contains("del-cmd")) {
    e.target.closest("tr").remove();
  }
};

// Open the settings modal box
document.getElementById("settings-btn").addEventListener("click", () => {
  renderSettingsForm();
  document.getElementById("settings-modal").classList.remove("hidden");
});

// Close settings
document.getElementById("close-settings").addEventListener("click", () => {
  document.getElementById("settings-modal").classList.add("hidden");
});

// Save settings
document.getElementById("save-settings").addEventListener("click", () => {
  saveCurrentSettings();
});

// Reset settings
document.getElementById("reset-settings").addEventListener("click", () => {
  if (confirm("Reset to default settings?")) {
    saveSettings({});
    document.getElementById("settings-modal").classList.add("hidden");
  }
});

// Automatically clean up checkbox change events
document.getElementById("auto-cleanup-enabled").addEventListener("change", (e) => {
  document.getElementById("max-file-age-days").disabled = !e.target.checked;
});

// Clean files manually
document.getElementById("purge-files").addEventListener("click", purgeAllFiles);

// prompt Automatically clean up checkbox change events
document.getElementById("auto-cleanup-prompt-enabled").addEventListener("change", (e) => {
  document.getElementById("max-prompt-age-days").disabled = !e.target.checked;
});


// New constraint button
document.getElementById("add-new-constraint").addEventListener("click", () => {
  openConstraintEditModal(); // If no parameters are passed, it means creating a new one.
});

// Constraint edit modal event
document.getElementById("cancel-constraint-edit").addEventListener("click", () => {
  document.getElementById("constraint-edit-modal").classList.add("hidden");
});

document.getElementById("save-constraint").addEventListener("click", saveConstraint);

// Using event delegation to handle editing and deletion of constraint lists
document.querySelector("#cmd-table tbody").addEventListener("click", (e) => {
  const constraintName = e.target.dataset.name;
  
  if (e.target.classList.contains("edit-constraint")) {
    // Edit constraints
    openConstraintEditModal(constraintName, customCmds[constraintName]);
  } else if (e.target.classList.contains("remove-constraint")) {
    // Delete constraints
    if (confirm(`Remove constraint "${constraintName}"?`)) {
      delete customCmds[constraintName];
      localStorage.setItem("ai_paste_cmds", JSON.stringify(customCmds));
      renderCmdTable();
      showStatus(`Constraint "${constraintName}" removed`, 'warning');
    }
  }
});


function renderCmdTable() {
  const tbody = document.querySelector("#cmd-table tbody");
  tbody.innerHTML = "";
  Object.entries(customCmds).forEach(([name, content]) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
    <td style="width: 60%; min-width: 40px; text-align: left;font-weight: bold">@${name}</td>
    <td style="width: 40%; min-width: 120px; text-align: right;white-space: nowrap;">
      <button class="edit-constraint modal-btn small" data-name="${name}" style="width: 60px;">Edit</button>
      <button class="remove-constraint modal-btn small danger" data-name="${name}" style="width: 60px;">Remove</button>
    </td>
    `;
    tbody.appendChild(tr);
  });
}

// --- exist@Support commands when completing ---
function showSuggestionListFor(editor, resetIndex = true, keyword = "") {
  
  const suggestionList = editor === promptBox ? 
    document.getElementById("suggestion-list") : 
    document.getElementById("depend-suggestion-list");

  // Hide another panel's suggestion list first
  if (editor === promptBox) {
    document.getElementById("depend-suggestion-list").classList.add("hidden");
  } else {
    document.getElementById("suggestion-list").classList.add("hidden");
  }
  
  suggestionList.innerHTML = "";

  // Merge files and commands
  const allList = [
    ...fileList.map(name => ({type:"file", name})),
    ...Object.keys(customCmds).map(name => ({type:"cmd", name}))
  ];
  
  const filteredList = keyword
    ? allList.filter(item => item.name.toLowerCase().includes(keyword.toLowerCase()))
    : allList;

  if (filteredList.length === 0) {
    const li = document.createElement("li");
    li.textContent = "(List is empty)";
    suggestionList.appendChild(li);
  } else {
    filteredList.forEach((item, idx) => {
      const li = document.createElement("li");
      li.textContent = item.name + (item.type === "cmd" ? " (cmd)" : "");
      li.dataset.filename = item.name;
      li.dataset.type = item.type;

      li.addEventListener("pointerdown", (evt) => {
        evt.preventDefault();

        if (editor === promptBox) {
          restorePromptSelection()
        } else {
          restoreDependSelection()
        }
        if (item.type === "file") {
          insertFileToken(item.name, editor);
        } else {
          insertCmdToken(item.name, editor);
        }
        hideSuggestionListFor(editor);
      });

      suggestionList.appendChild(li);
    });
  }

  // ...Subsequent positioning and highlighting logic remains unchanged...
  // Calculate cursor position，Let the list hover under the cursor
  let top = 0, left = 0;
  let alignLeft = true; // Defaults to the right of the cursor
  const sel = window.getSelection();
  
  if (sel && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0).cloneRange();
    saveSelectionRange();
    const tempSpan = document.createElement("span");
    tempSpan.textContent = "\u200b";
    range.insertNode(tempSpan);

    const rect = tempSpan.getBoundingClientRect();
    const promptRect = promptBox.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    
    // base position（Cursor lower right corner）
    top = rect.bottom + window.scrollY;
    left = rect.left + window.scrollX;
    
    // suggestion Estimated size of list
    const suggestionWidth = 200; // andCSSset inwidthconsistent
    const suggestionHeight = Math.min(suggestionList.scrollHeight, 150); // andCSSmiddlemaxHeightconsistent
    
    // Check if there is enough space on the right
    const spaceOnRight = viewportWidth - rect.right;
    const spaceOnLeft = rect.left;
    
    // If there is not enough space on the right，But there is enough space on the left side，is displayed on the left
    if (spaceOnRight < suggestionWidth && spaceOnLeft >= suggestionWidth) {
      alignLeft = false;
      left = rect.left + window.scrollX - suggestionWidth;
    }
    // If there is not enough space on both sides，Choose the side with more space
    else if (spaceOnRight < suggestionWidth && spaceOnLeft < suggestionWidth) {
      alignLeft = spaceOnRight >= spaceOnLeft;
      if (!alignLeft) {
        left = rect.left + window.scrollX - suggestionWidth;
      }
    }
    
    // Vertical adjustment：Make sure not to exceed the visible area
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    
    // If there is not enough space below，But there is enough space above，is displayed above
    if (spaceBelow < suggestionHeight && spaceAbove >= suggestionHeight) {
      top = rect.top + window.scrollY - suggestionHeight;
    }
    // If there is not enough space up and down，Choose the side with more space
    else if (spaceBelow < suggestionHeight && spaceAbove < suggestionHeight) {
      if (spaceAbove >= spaceBelow) {
        top = rect.top + window.scrollY - suggestionHeight;
      }
    }
    
    // Make sure not to exceed prompt box bounds
    if (top < promptRect.top + window.scrollY) {
      top = promptRect.top + window.scrollY;
    }
    if (top + suggestionHeight > promptRect.bottom + window.scrollY) {
      top = promptRect.bottom + window.scrollY - suggestionHeight;
    }
    
    // Make sure you don't exceed the viewport boundaries
    if (left < 0) left = 5;
    if (left + suggestionWidth > viewportWidth) {
      left = viewportWidth - suggestionWidth - 5;
    }

    tempSpan.remove();
    if (editor === promptBox) {
      restorePromptSelection()
    } else {
      restoreDependSelection()
    }
  } else {
    // When the cursor is not available，Default in prompt center bottom
    const rect = promptBox.getBoundingClientRect();
    top = rect.bottom + window.scrollY;
    left = rect.left + window.scrollX + 10;
  }

  // Position after applying calculation
  suggestionList.style.position = "absolute";
  suggestionList.style.top = `${top}px`;
  suggestionList.style.left = `${left}px`;
  suggestionList.style.width = "200px";
  suggestionList.style.maxHeight = "150px";
  suggestionList.style.overflowY = "auto";
  suggestionList.style.zIndex = 10000;

  suggestionList.classList.remove("hidden");

  if (resetIndex) {
    currentIndex = 0;
  }
  highlightSuggestionItem(suggestionList);
}

function hideSuggestionListFor(editor) {
  const suggestionList = editor === promptBox ? 
    document.getElementById("suggestion-list") : 
    document.getElementById("depend-suggestion-list");
    
  suggestionList.classList.add("hidden");
  currentIndex = -1;
}

function highlightSuggestionItem(suggestionList) {
  const items = suggestionList.querySelectorAll("li");
  items.forEach((el, idx) => {
    el.classList.toggle("highlight", idx === currentIndex);
    if (idx === currentIndex) {
      el.scrollIntoView({ block: "nearest" });
    }
  });
}

function hideSuggestionListFor(editor) {
  const suggestionList = editor === promptBox ? 
    document.getElementById("suggestion-list") : 
    document.getElementById("depend-suggestion-list");
    
  suggestionList.classList.add("hidden");
  currentIndex = -1;
}

function highlightSuggestionItem(suggestionList) {
  const items = suggestionList.querySelectorAll("li");
  items.forEach((el, idx) => {
    el.classList.toggle("highlight", idx === currentIndex);
    if (idx === currentIndex) {
      el.scrollIntoView({ block: "nearest" });
    }
  });
}

function loadSettings() {
  return JSON.parse(localStorage.getItem("ai_paste_settings") || "{}");
}

function saveSettings(settings) {
  localStorage.setItem("ai_paste_settings", JSON.stringify(settings));
}

function getSetting(key) {
  const settings = loadSettings();
  return settings[key] !== undefined ? settings[key] : defaultSettings[key];
}

function renderSettingsForm() {
  const settings = {...defaultSettings, ...loadSettings()};
  
  // Numeric settings
  document.getElementById("max-total-storage-kb").value = settings.maxTotalStorageKB;
  document.getElementById("max-file-size-kb").value = settings.maxFileSizeKB;
  document.getElementById("max-files-count").value = settings.maxFilesCount;
  document.getElementById("max-file-age-days").value = settings.maxFileAgeDays;
  document.getElementById("max-constraint-words").value = settings.maxConstraintWords;
  document.getElementById("max-constraints-count").value = settings.maxConstraintsCount;
  document.getElementById("max-prompt-kb").value = settings.maxPromptKB;
  document.getElementById("max-prompt-age-days").value = settings.maxPromptAgeDays;
  
  // Switch type setting
  document.getElementById("auto-cleanup-enabled").checked = settings.autoCleanupEnabled;
  document.getElementById("auto-cleanup-prompt-enabled").checked = settings.autoCleanupPromptEnabled;
  
  // Set the disabled state of the relevant input according to the switch state
  document.getElementById("max-file-age-days").disabled = !settings.autoCleanupEnabled;
  document.getElementById("max-prompt-age-days").disabled = !settings.autoCleanupPromptEnabled;
}

function saveCurrentSettings() {
  const settings = {
    maxTotalStorageKB: parseInt(document.getElementById("max-total-storage-kb").value),
    maxFileSizeKB: parseInt(document.getElementById("max-file-size-kb").value),
    maxFilesCount: parseInt(document.getElementById("max-files-count").value),
    maxFileAgeDays: parseInt(document.getElementById("max-file-age-days").value),
    maxConstraintWords: parseInt(document.getElementById("max-constraint-words").value),
    maxConstraintsCount: parseInt(document.getElementById("max-constraints-count").value),
    maxPromptKB: parseInt(document.getElementById("max-prompt-kb").value),
    maxPromptAgeDays: parseInt(document.getElementById("max-prompt-age-days").value),
    autoCleanupEnabled: document.getElementById("auto-cleanup-enabled").checked,
    autoCleanupPromptEnabled: document.getElementById("auto-cleanup-prompt-enabled").checked
  };
  saveSettings(settings);
  document.getElementById("settings-modal").classList.add("hidden");
}

function autoCleanupFiles() {
  if (!getSetting('autoCleanupEnabled')) {
    return 0;
  }
  
  const maxAgeDays = getSetting('maxFileAgeDays');
  const cutoffTime = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
  const timestamps = JSON.parse(localStorage.getItem("ai_paste_fileTimestamps") || "{}");
  
  let cleanedCount = 0;
  
  // Check the timestamp of each file
  Object.keys(timestamps).forEach(filename => {
    if (timestamps[filename] < cutoffTime) {
      // Delete expired files
      delete files[filename];
      delete timestamps[filename];
      
      const idx = fileList.indexOf(filename);
      if (idx >= 0) {
        fileList.splice(idx, 1);
      }
      
      cleanedCount++;
      console.log(`Cleaned expired file: ${filename}`);
    }
  });
  
  // Save updated timestamp
  localStorage.setItem("ai_paste_fileTimestamps", JSON.stringify(timestamps));
  
  if (cleanedCount > 0) {
    updateFileList(); // Update display and storage
  }
  
  return cleanedCount;
}

document.getElementById("file-list").addEventListener("click", (e) => {
  if (e.target.classList.contains("delete-file")) {
    const parentDiv = e.target.parentElement;
    const fname = parentDiv.dataset.filename;

    // from files and fileList Delete in
    delete files[fname];
    const idx = fileList.indexOf(fname);
    if (idx >= 0) fileList.splice(idx, 1);
    
    // Remove timestamp
    const timestamps = JSON.parse(localStorage.getItem("ai_paste_fileTimestamps") || "{}");
    delete timestamps[fname];
    localStorage.setItem("ai_paste_fileTimestamps", JSON.stringify(timestamps));

    updateFileList();
  }
});

function purgeAllFiles() {
  if (confirm("This will delete ALL files, but commands will be preserved. Are you sure?")) {
    // Clear file related data
    files = {};
    fileList = [];
    
    // Clear file timestamp
    localStorage.removeItem("ai_paste_fileTimestamps");
    
    // Update display
    updateFileList();
    
    // Show success message
    showStatus("All files have been purged", 'warning');
    
    // Close settings modal box
    document.getElementById("settings-modal").classList.add("hidden");
  }
}

// Open the constraint editing modal box
function openConstraintEditModal(constraintName = null, content = "") {
  editingConstraintName = constraintName;
  
  // Set modal box title
  document.getElementById("constraint-edit-title").textContent = 
    constraintName ? "Edit Constraint" : "New Constraint";
  
  // Fill data
  document.getElementById("edit-constraint-name").value = constraintName || "";
  document.getElementById("edit-constraint-content").value = content;
  
  // Show modal box
  document.getElementById("constraint-edit-modal").classList.remove("hidden");
}

// Save constraints
function saveConstraint() {
  const name = document.getElementById("edit-constraint-name").value.trim();
  const content = document.getElementById("edit-constraint-content").value.trim();
  
  // Validate input
  if (!name) {
    alert("Please enter a constraint name");
    return;
  }
  
  if (!content) {
    alert("Please enter constraint content");
    return;
  }
  
  // Check if name already exists（If it is new or renamed）
  if (editingConstraintName !== name && customCmds[name]) {
    alert(`Constraint "${name}" already exists`);
    return;
  }
  
  // If you are editing an existing constraint and renaming it，Need to delete the old one
  if (editingConstraintName && editingConstraintName !== name) {
    delete customCmds[editingConstraintName];
  }
  
  // Save constraints
  customCmds[name] = content;
  localStorage.setItem("ai_paste_cmds", JSON.stringify(customCmds));
  
  // Close the modal and refresh the list
  document.getElementById("constraint-edit-modal").classList.add("hidden");
  renderCmdTable();
  
  showStatus(`Constraint "${name}" saved`, true);
}

function saveCurrentPrompt() {
  localStorage.setItem("ai_paste_prompt", promptBox.innerHTML);
  localStorage.setItem("ai_paste_promptTimestamp", Date.now().toString());
}
function saveCurrentDepend() {
  localStorage.setItem("ai_paste_depend", dependBox.innerHTML);
  localStorage.setItem("ai_paste_dependTimestamp", Date.now().toString());
}

function shortenFileName(filename) {
  const idx = filename.lastIndexOf(".");
  let name, ext;
  
  if (idx === -1) {
    name = filename;
    ext = "";
  } else {
    name = filename.slice(0, idx);
    ext = filename.slice(idx);
  }
  
  // Only the file name part is longer than10abbreviation
  if (name.length <= 10) return filename;
  return name.slice(0, 7) + "..." + name.slice(-3) + ext;
}

function formatFileSize(content) {
  const bytes = new TextEncoder().encode(content).length;
  if (bytes < 1024) return bytes + " B";
  return (bytes / 1024).toFixed(1) + " KB";
}

function showConfirmModal(message) {
    return new Promise(resolve => {
        const modal = document.getElementById("confirmModal");
        document.getElementById("confirmMessage").textContent = message;

        modal.style.display = "flex";

        const yes = () => {
            cleanup();
            resolve(true);
        };
        const no = () => {
            cleanup();
            resolve(false);
        };

        function cleanup() {
            modal.style.display = "none";
            document.getElementById("confirmYes").removeEventListener("click", yes);
            document.getElementById("confirmNo").removeEventListener("click", no);
        }

        document.getElementById("confirmYes").addEventListener("click", yes);
        document.getElementById("confirmNo").addEventListener("click", no);
    });
}

function restorePromptSelection() {
  const sel = window.getSelection();
  sel.removeAllRanges();
  if (promptSavedRange) sel.addRange(promptSavedRange);
}

function restoreDependSelection() {
  const sel = window.getSelection();
  sel.removeAllRanges();
  if (dependSavedRange) sel.addRange(dependSavedRange);
}

function extractFileReferences(container) {
  let text = "";
  
  container.childNodes.forEach(node => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.classList.contains("file-token")) {
        // Extract only file names，wrapped in quotation marks
        const fname = node.getAttribute("data-filename");
        text += `"# FILE: ${fname}"`;
      } else if (node.classList.contains("cmd-token")) {
        // for constraintstoken，Also keep showing only the name
        const cmdKey = node.getAttribute("data-cmd");
        text += `"[CONSTRAINT: ${cmdKey}]"`;
      } else {
        // otherHTMLelement
        text += node.innerText || node.textContent || "";
      }
    }
  });
  
  return text;
}

function extractTextContent(container) {
  let text = "";
  container.childNodes.forEach(node => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.classList.contains("file-token") || node.classList.contains("cmd-token")) {
        // Handle token
        if (node.classList.contains("file-token")) {
          const fname = node.getAttribute("data-filename");
          text += `\n\n===== File: ${fname} =====\n`;
          text += files[fname]?.content || "(file not found)";
          text += `\n\n===== End of ${fname} =====\n`;
        } else if (node.classList.contains("cmd-token")) {
          const cmdKey = node.getAttribute("data-cmd");
          text += customCmds[cmdKey] || `(command not found: ${cmdKey})`;
        }
      } else {
        text += node.innerText || node.textContent || "";
      }
    }
  });
  return text;
}

// Helper functions for creating tokens
function createFileToken(filename) {
  const token = document.createElement("span");
  token.className = "file-token";
  token.setAttribute("data-filename", filename);
  token.contentEditable = "false";
  token.innerHTML = `<svg viewBox="0 0 16 16" width="12" height="12" style="vertical-align:middle;margin-right:4px;">
    <rect width="16" height="16" fill="#bbb"></rect>
  </svg>${filename}`;
  return token;
}

function createCmdToken(cmdKey) {
  const token = document.createElement("span");
  token.className = "cmd-token";
  token.setAttribute("data-cmd", cmdKey);
  token.contentEditable = "false";
  token.innerHTML = `<svg viewBox="0 0 16 16" width="12" height="12" style="vertical-align:middle;margin-right:4px;">
    <circle cx="8" cy="8" r="8" fill="#8bc34a"></circle>
  </svg>${cmdKey}`;
  return token;
}

function saveSelectionRange(editor) {
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    if (editor === promptBox) {
      promptSavedRange = sel.getRangeAt(0).cloneRange();
    } else {
      dependSavedRange = sel.getRangeAt(0).cloneRange();
    }
  }
}

// Collect all file contents（Reuse existing logic）
function collectAllFileContents(...editors) {
  const fileMap = {};
  
  editors.forEach(editor => {
    editor.querySelectorAll('.file-token').forEach(token => {
      const filename = token.getAttribute('data-filename');
      if (files[filename] && !fileMap[filename]) {
        fileMap[filename] = {
          content: files[filename].content,
          desc: files[filename].desc || `File: ${filename}`
        };
      }
    });
  });
  
  return fileMap;
}

// Collection constraints
function collectConstraints() {
  return Object.entries(customCmds).map(([name, content]) => ({
    name,
    content
  }));
}

// Build template（core function）
function buildTemplate({ task, dependencies, constraints, files }) {
  let template = `I need you to rewrite the target file based on the structure and logic of the reference files.
Below are the task description, constraints, and the complete content of all files.

===========================
【TASK OBJECTIVE】
===========================

${task.trim()}

===========================
【CONSTRAINTS THAT MUST BE SATISFIED】
===========================

`;

  // Add constraints
  constraints.forEach((constraint, index) => {
    template += `${index + 1}. ${constraint.content.trim()}\n`;
  });

  // Add dependencies
  if (dependencies.trim()) {
    template += `
===========================
【DEPENDENCY RELATIONSHIPS BETWEEN FILES】
===========================

${dependencies.trim()}
`;
  }

  // Add file content
  template += `
===========================
【ATTACHED FILE CONTENTS】
===========================

Below I will provide the content of each file one by one, using the format that works best for the model.

`;

  Object.entries(files).forEach(([filename, file], index) => {
    template += `'''
----------------------------------
# FILE: ${filename}
# PURPOSE: ${file.desc || 'No description provided'}
# BEGIN FILE
${file.content.trim()}
# END FILE
----------------------------------
'''
`;
  });

  template += `(All attached files end here)`;

  return template;
}