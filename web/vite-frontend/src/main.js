import { marked } from "marked";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { createLayoutController } from "./features/layout/resizers.js";
import { createImageLightbox } from "./features/media/imageLightbox.js";
import { classifyPath, createSessionFileTree } from "./features/session/fileTree.js";
import {
  compactRepeatedPrefixSnapshots,
  mergeReplayedText,
  upsertTimelineEvent,
  upsertTimelineText,
  upsertTimelineThought,
} from "./features/chat/timeline.js";
import { AgentGraphView, StepExecutionFeed } from "./features/graphs/AgentGraphView.js";
import { ExecutionPlanView } from "./features/graphs/ExecutionPlanView.js";
import { createSkillGraphController } from "./features/skills/SkillGraphController.js";
import { createSettingsController } from "./features/settings/SettingsController.js";
import "./style.css";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const APP_NAME = "MatCreator";

const AGENT_MODE_KEY = "mat_agentMode";
const THEME_KEY = "mat_theme";

const state = {
  sessionId: localStorage.getItem("mat_sessionId") || newSessionId(),
  userId: localStorage.getItem("mat_userId") || "",
  displayName: localStorage.getItem("mat_displayName") || localStorage.getItem("mat_userId") || "",
  activeSessionUserId: localStorage.getItem("mat_userId") || "",
  isAdmin: false,
  deploymentMode: localStorage.getItem("mat_deploymentMode") || "local",
  sessionReady: false,
  sessionStatusFilter: "all",
  structure3dViewer: null,
  activeCenterTabId: "chat",
  currentUploads: [],
  activeRequests: new Map(),
  sessionViewCache: new Map(),
  agentMode: localStorage.getItem(AGENT_MODE_KEY) || "normal",
  theme: localStorage.getItem(THEME_KEY) || "dark",
  customWorkdir: "",
  sessionSummaries: {},   // { sessionId: "summary text" }
  summaryGeneratedFor: new Set(),  // sessionIds that have triggered summary generation
  remoteJobs: [],
  remoteJobsExpanded: false,
  appMode: "workspace",
  evaluationCatalog: [],
  evaluationCatalogTotal: null,
  evaluationCatalogFacets: {},
  evaluationQuestionSets: [],
  evaluationGeneratedQuestions: [],
  activeEvaluationQuestionSetId: "",
  selectedEvaluationQuestions: new Set(),
  activeEvaluationCampaign: null,
};

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const chatArea = document.getElementById("chat-area");
const textInput = document.getElementById("text-input");
const inputContainer = document.querySelector(".input-container");
const sendBtn = document.getElementById("send-btn");
const fileUploadBtn = document.getElementById("file-upload-btn");
const fileUploadInput = document.getElementById("file-upload-input");
const uploadStatus = document.getElementById("upload-status");
const sessionIdEl = document.getElementById("session-id");
const sessionListEl = document.getElementById("session-list");
const resetBtn = document.getElementById("reset-session");
const workspaceCliToggle = document.getElementById("workspace-cli-toggle");
const skillGraphOpenBtn = document.getElementById("skill-graph-open");
const themeToggle = document.getElementById("theme-toggle");
const refreshSessionsBtn = document.getElementById("refresh-sessions");
const sessionStatusFilter = document.getElementById("session-status-filter");
const graphViewport = document.getElementById("graph-viewport");
const graphDetail = document.getElementById("graph-detail");
const centerTabs = document.getElementById("center-tabs");
const centerTabsScroll = document.getElementById("center-tabs-scroll");
const centerTabPanels = document.getElementById("center-tab-panels");
const loginModal = document.getElementById("login-modal");
const loginInput = document.getElementById("login-input");
const loginPassword = document.getElementById("login-password");
const loginError = document.getElementById("login-error");
const loginUuidDisplay = document.getElementById("login-uuid-display");
const loginSubmit = document.getElementById("login-submit");
const loginView = document.getElementById("login-view");
const registerView = document.getElementById("register-view");
const regInput = document.getElementById("reg-input");
const regPassword = document.getElementById("reg-password");
const regConfirm = document.getElementById("reg-confirm");
const regError = document.getElementById("reg-error");
const regSubmit = document.getElementById("reg-submit");
const switchToRegister = document.getElementById("switch-to-register");
const switchToLogin = document.getElementById("switch-to-login");
const userDisplay = document.getElementById("user-display");
const editUserBtn = document.getElementById("edit-user");
const logoutBtn = document.getElementById("logout-btn");
const settingsLogoutBtn = document.getElementById("settings-logout-btn");
const benchToggle = null; // removed — replaced by mode-selector
const modeSelector = document.getElementById("mode-selector");
const sessionSummaryText = document.getElementById("session-summary-text");
const chatTab = document.getElementById("tab-chat");
const filesColToggleBtn = document.getElementById("files-col-toggle");
const knowledgeReviewBanner = document.getElementById("knowledge-review-banner");
const knowledgeReviewText = document.getElementById("knowledge-review-text");
const knowledgeReviewSpinner = document.getElementById("knowledge-review-spinner");
const workspaceCli = document.getElementById("workspace-cli");
const workspaceTerminalEl = document.getElementById("workspace-terminal");
const remoteJobListEl = document.getElementById("remote-job-list");
const refreshRemoteJobsBtn = document.getElementById("refresh-remote-jobs");
const remoteJobsToggleBtn = document.getElementById("remote-jobs-toggle");
const remoteJobsPane = document.getElementById("remote-jobs-pane");
const workspaceModeBtn = document.getElementById("workspace-mode-btn");
const evaluationModeBtn = document.getElementById("evaluation-mode-btn");
const evaluationPane = document.getElementById("evaluation-pane");
const evaluationTab = document.getElementById("tab-evaluation");
const evaluationTabPanel = document.getElementById("evaluation-tab-panel");
const evaluationQuestionList = document.getElementById("evaluation-question-list");
const evaluationSelectionCount = document.getElementById("evaluation-selection-count");
const evaluationStatus = document.getElementById("evaluation-status");
const evaluationCampaignSummary = document.getElementById("evaluation-campaign-summary");
const evaluationCampaignList = document.getElementById("evaluation-campaign-list");
const evaluationLiveFeed = document.getElementById("evaluation-live-feed");
let evaluationPoll = null;
let knowledgeReviewPoll = null;
let remoteJobsPoll = null;
let workspaceTerminal = null;
let workspaceTerminalFit = null;
let workspaceTerminalSocket = null;
let workspaceTerminalPointerDown = false;
let workspaceTerminalSelectionReleasedAt = 0;
let workspaceTerminalCtrlCKeyAt = 0;
const structureTabs = new Map();
let structureViewerModulePromise = null;
let svelteRuntimePromise = null;

const settingsController = createSettingsController({ state, applyLogin });

const skillGraphController = createSkillGraphController({
  state,
  centerTabs,
  centerTabPanels,
  activateCenterTab,
  renderMarkdown,
});

const { render: renderSessionFilesTree } = createSessionFileTree({
  getSessionId: () => state.sessionId,
  pathToApiUrl: (path) => pathToApiUrl(path),
  openStructure: (item) => openViewer(item),
  openFile: (file) => openFileViewer(file),
});

function loadStructureViewerModules() {
  structureViewerModulePromise ||= import("./structure/StructureViewer.svelte");
  svelteRuntimePromise ||= import("svelte");
  return Promise.all([structureViewerModulePromise, svelteRuntimePromise]);
}

const scheduleStructureViewerPreload = window.requestIdleCallback
  ? (callback) => window.requestIdleCallback(callback, { timeout: 2000 })
  : (callback) => window.setTimeout(callback, 1000);
scheduleStructureViewerPreload(() => void loadStructureViewerModules());

function sessionTabTooltip(title) {
  return `${title || "Chat"}\nDouble-click to edit session name`;
}

function autoResizeTextInput() {
  if (!textInput) return;
  textInput.style.height = "auto";
  const computed = window.getComputedStyle(textInput);
  const lineHeight = parseFloat(computed.lineHeight) || 24;
  const maxHeight = lineHeight * 3;
  const nextHeight = Math.min(textInput.scrollHeight, maxHeight);
  textInput.style.height = `${nextHeight}px`;
  textInput.style.overflowY = textInput.scrollHeight > maxHeight ? "auto" : "hidden";
}

autoResizeTextInput();
textInput?.addEventListener("input", autoResizeTextInput);

function applyTheme(theme) {
  const nextTheme = theme === "light" ? "light" : "dark";
  state.theme = nextTheme;
  document.body.dataset.theme = nextTheme;
  window.dispatchEvent(new CustomEvent("matcreator-theme-change", { detail: nextTheme }));
  themeToggle?.setAttribute("aria-pressed", String(nextTheme === "light"));
  themeToggle?.setAttribute("title", nextTheme === "light" ? "Toggle dark mode" : "Toggle light mode");
  themeToggle?.setAttribute("aria-label", nextTheme === "light" ? "Toggle dark mode" : "Toggle light mode");
}

applyTheme(state.theme);
themeToggle?.addEventListener("click", () => {
  const nextTheme = state.theme === "light" ? "dark" : "light";
  localStorage.setItem(THEME_KEY, nextTheme);
  applyTheme(nextTheme);
});

sessionIdEl.textContent = state.sessionId;
if (state.userId) userDisplay.textContent = state.displayName || state.userId;
refreshKnowledgeReviewStatus();

function setEvaluationStatus(message = "", isError = false) {
  if (!evaluationStatus) return;
  evaluationStatus.textContent = message;
  evaluationStatus.classList.toggle("is-error", isError);
}

function questionSetById(setId) {
  return state.evaluationQuestionSets.find((questionSet) => questionSet.set_id === setId) || null;
}

function renderEvaluationQuestionSets() {
  const select = document.getElementById("evaluation-question-set-select");
  const updateButton = document.getElementById("evaluation-update-question-set");
  const deleteButton = document.getElementById("evaluation-delete-question-set");
  if (!select) return;
  const selectedId = state.activeEvaluationQuestionSetId;
  select.innerHTML = '<option value="">Load a saved set</option>';
  for (const questionSet of state.evaluationQuestionSets) {
    const option = document.createElement("option");
    option.value = questionSet.set_id;
    option.textContent = `${questionSet.name} (${questionSet.visibility})`;
    select.appendChild(option);
  }
  select.value = selectedId;
  const active = questionSetById(selectedId);
  const owned = active?.owner_id === state.userId;
  updateButton.disabled = !owned;
  deleteButton.disabled = !owned;
}

function renderEvaluationGeneratedQuestions() {
  const list = document.getElementById("evaluation-generated-question-list");
  if (!list) return;
  list.innerHTML = "";
  if (!state.evaluationGeneratedQuestions.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No generated questions yet";
    list.appendChild(empty);
    return;
  }
  for (const draft of state.evaluationGeneratedQuestions) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "evaluation-generated-question";
    row.title = "Browse generated question YAML";
    const heading = document.createElement("span");
    heading.className = "evaluation-generated-question-heading";
    const questionId = document.createElement("strong");
    questionId.textContent = draft.question_id || "Untitled question";
    const status = document.createElement("span");
    status.className = `evaluation-generated-question-status status-${draft.status}`;
    status.textContent = draft.status.replaceAll("_", " ");
    heading.append(questionId, status);
    const meta = document.createElement("span");
    meta.className = "evaluation-generated-question-meta";
    meta.textContent = `Session ${draft.source_session_id || "unknown"} · ${draft.refinement_count || 0} refinements`;
    row.append(heading, meta);
    row.addEventListener("click", async () => {
      try {
        const response = await fetch(
          `/api/evaluation-question-drafts/${encodeURIComponent(draft.draft_id)}?user_id=${encodeURIComponent(state.userId)}`,
        );
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.detail || `HTTP ${response.status}`);
        showEvaluationQuestionDraftModal(data);
      } catch (error) {
        setEvaluationStatus(`Could not open generated question: ${error.message}`, true);
      }
    });
    list.appendChild(row);
  }
}

async function loadEvaluationGeneratedQuestions() {
  if (!state.userId) return;
  try {
    const response = await fetch(
      `/api/evaluation-question-drafts?user_id=${encodeURIComponent(state.userId)}`,
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || `HTTP ${response.status}`);
    state.evaluationGeneratedQuestions = data.drafts || [];
    renderEvaluationGeneratedQuestions();
  } catch (error) {
    setEvaluationStatus(`Could not load generated questions: ${error.message}`, true);
  }
}

async function loadEvaluationQuestionSets() {
  if (!state.userId) return;
  try {
    const response = await fetch(`/api/evaluations/question-sets?user_id=${encodeURIComponent(state.userId)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(apiErrorMessage(data, `HTTP ${response.status}`));
    state.evaluationQuestionSets = data.question_sets || [];
    if (!questionSetById(state.activeEvaluationQuestionSetId)) state.activeEvaluationQuestionSetId = "";
    renderEvaluationQuestionSets();
  } catch (error) {
    setEvaluationStatus(`Could not load question sets: ${error.message}`, true);
  }
}

function loadSelectedQuestionSet(setId) {
  state.activeEvaluationQuestionSetId = setId;
  const questionSet = questionSetById(setId);
  if (questionSet) {
    state.selectedEvaluationQuestions = new Set(questionSet.question_ids || []);
    document.getElementById("evaluation-question-set-name").value = questionSet.name;
    document.getElementById("evaluation-question-set-visibility").value = questionSet.visibility;
    renderEvaluationQuestions();
  }
  renderEvaluationQuestionSets();
}

async function saveEvaluationQuestionSet(update = false) {
  const active = questionSetById(state.activeEvaluationQuestionSetId);
  if (update && active?.owner_id !== state.userId) return;
  const name = document.getElementById("evaluation-question-set-name")?.value.trim();
  const visibility = document.getElementById("evaluation-question-set-visibility")?.value || "private";
  if (!name || !state.selectedEvaluationQuestions.size) {
    setEvaluationStatus("A set name and at least one selected question are required", true);
    return;
  }
  const path = update ? `/api/evaluations/question-sets/${encodeURIComponent(active.set_id)}` : "/api/evaluations/question-sets";
  try {
    const response = await fetch(`${path}?user_id=${encodeURIComponent(state.userId)}`, {
      method: update ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, visibility, question_ids: [...state.selectedEvaluationQuestions] }),
    });
    const questionSet = await response.json();
    if (!response.ok) throw new Error(apiErrorMessage(questionSet, `HTTP ${response.status}`));
    state.activeEvaluationQuestionSetId = questionSet.set_id;
    await loadEvaluationQuestionSets();
    setEvaluationStatus(update ? "Question set updated" : "Question set saved");
  } catch (error) {
    setEvaluationStatus(`Could not save question set: ${error.message}`, true);
  }
}

async function deleteEvaluationQuestionSet() {
  const active = questionSetById(state.activeEvaluationQuestionSetId);
  if (!active || active.owner_id !== state.userId) return;
  try {
    const response = await fetch(
      `/api/evaluations/question-sets/${encodeURIComponent(active.set_id)}?user_id=${encodeURIComponent(state.userId)}`,
      { method: "DELETE" },
    );
    if (!response.ok) throw new Error(apiErrorMessage(await response.json(), `HTTP ${response.status}`));
    state.activeEvaluationQuestionSetId = "";
    await loadEvaluationQuestionSets();
    setEvaluationStatus("Question set deleted");
  } catch (error) {
    setEvaluationStatus(`Could not delete question set: ${error.message}`, true);
  }
}

function apiErrorMessage(data, fallback) {
  const detail = data?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail.map((item) => {
      const field = Array.isArray(item?.loc) ? item.loc.filter((part) => part !== "body").join(".") : "request";
      return `${field || "request"}: ${item?.msg || "invalid value"}`;
    }).join("; ");
  }
  return fallback;
}

function renderEvaluationQuestions() {
  if (!evaluationQuestionList) return;
  evaluationQuestionList.innerHTML = "";
  const selectedOnly = document.getElementById("evaluation-selected-only")?.checked;
  const questions = selectedOnly
    ? state.evaluationCatalog.filter((question) => state.selectedEvaluationQuestions.has(question.id))
    : state.evaluationCatalog;
  if (!questions.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No benchmark questions loaded";
    evaluationQuestionList.appendChild(empty);
  }
  for (const question of questions) {
    const row = document.createElement("label");
    row.className = "evaluation-question-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selectedEvaluationQuestions.has(question.id);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selectedEvaluationQuestions.add(question.id);
      else state.selectedEvaluationQuestions.delete(question.id);
      renderEvaluationQuestions();
    });
    const details = document.createElement("span");
    details.className = "evaluation-question-details";
    const title = document.createElement("strong");
    title.textContent = question.id || "Unnamed question";
    const meta = document.createElement("span");
    meta.textContent = [question.domain, question.capability, question.intent].filter(Boolean).join(" · ") || "No metadata";
    details.append(title, meta);
    row.append(checkbox, details);
    evaluationQuestionList.appendChild(row);
  }
  if (evaluationSelectionCount) {
    const count = state.selectedEvaluationQuestions.size;
    const catalogCount = Number.isInteger(state.evaluationCatalogTotal)
      ? `${state.evaluationCatalogTotal} total questions`
      : `${state.evaluationCatalog.length} loaded questions`;
    evaluationSelectionCount.textContent = `${count} selected · ${catalogCount}`;
  }
}

function populateEvaluationSelect(id, values, placeholder) {
  const select = document.getElementById(id);
  if (!select) return;
  const current = select.value;
  select.innerHTML = "";
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = placeholder;
  select.appendChild(empty);
  for (const value of [...new Set(values.filter(Boolean))].sort()) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  }
  select.value = current;
}

async function loadEvaluationCatalog() {
  const params = new URLSearchParams({ limit: "500" });
  const search = document.getElementById("evaluation-search")?.value.trim();
  const domain = document.getElementById("evaluation-domain")?.value.trim();
  const capability = document.getElementById("evaluation-capability")?.value.trim();
  const taskType = document.getElementById("evaluation-task-type")?.value.trim();
  if (search) params.set("q", search);
  if (domain) params.set("domain", domain);
  if (capability) params.set("capability", capability);
  if (taskType) params.set("task_type", taskType);
  setEvaluationStatus("Loading catalog");
  try {
    if (state.userId) params.set("user_id", state.userId);
    const response = await fetch(`/api/evaluations/catalog?${params}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || `HTTP ${response.status}`);
    state.evaluationCatalog = data.questions || [];
    state.evaluationCatalogTotal = Number.isInteger(data.total) ? data.total : null;
    state.evaluationCatalogFacets = data.facets || {};
    populateEvaluationSelect("evaluation-domain", data.facets?.domain || state.evaluationCatalog.map((item) => item.domain), "All domains");
    populateEvaluationSelect(
      "evaluation-capability",
      data.facets?.capability || state.evaluationCatalog.flatMap((item) => Array.isArray(item.capability) ? item.capability : [item.capability]),
      "All capabilities",
    );
    populateEvaluationSelect(
      "evaluation-task-type",
      data.facets?.task_type || state.evaluationCatalog.map((item) => item.task_type),
      "All task types",
    );
    renderEvaluationQuestions();
    setEvaluationStatus("");
  } catch (error) {
    setEvaluationStatus(`Catalog unavailable: ${error.message}`, true);
  }
}

function renderEvaluationCampaign(campaign) {
  if (!evaluationCampaignSummary) return;
  if (!campaign) {
    evaluationCampaignSummary.textContent = "Select questions to create an evaluation campaign.";
    return;
  }
  const attempts = campaign.attempts || [];
  const counts = attempts.reduce((result, attempt) => {
    result[attempt.status] = (result[attempt.status] || 0) + 1;
    return result;
  }, {});
  const completed = counts.completed || 0;
  const score = attempts
    .map((attempt) => Number(attempt.result?.weighted_score))
    .filter(Number.isFinite);
  const average = score.length ? (score.reduce((sum, value) => sum + value, 0) / score.length).toFixed(3) : "Pending";
  evaluationCampaignSummary.innerHTML = "";
  const status = document.createElement("strong");
  status.textContent = `${campaign.status} · ${completed}/${attempts.length} completed`;
  const result = document.createElement("span");
  result.textContent = `Score: ${average}`;
  evaluationCampaignSummary.append(status, result);
  if (["starting", "active", "cancelling"].includes(campaign.status)) {
    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "evaluation-cancel-btn";
    cancelButton.textContent = campaign.status === "cancelling" ? "Cancelling" : "Stop evaluation";
    cancelButton.disabled = campaign.status === "cancelling";
    cancelButton.addEventListener("click", () => void cancelEvaluationCampaign(campaign));
    evaluationCampaignSummary.appendChild(cancelButton);
  }
  for (const attempt of attempts) {
    const row = document.createElement("div");
    row.className = "evaluation-attempt-row";
    const label = document.createElement("span");
    label.textContent = `${attempt.question_id} · ${attempt.status}`;
    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "evaluation-attempt-open";
    openButton.textContent = "Open session";
    openButton.disabled = !attempt.runtime_session_id;
    openButton.addEventListener("click", () => openEvaluationAttempt(campaign, attempt));
    row.append(label, openButton);
    evaluationCampaignSummary.appendChild(row);
    const task = attempt.task_payload || {};
    if (task.prompt) {
      const details = document.createElement("details");
      details.className = "evaluation-task-details";
      const summary = document.createElement("summary");
      summary.textContent = "Question sent to agent";
      const prompt = document.createElement("pre");
      prompt.textContent = task.prompt;
      details.append(summary, prompt);
      if (task.data_files?.length) {
        const files = document.createElement("p");
        files.className = "evaluation-task-files";
        files.textContent = `Input files: ${task.data_files.join(", ")}`;
        details.appendChild(files);
      }
      evaluationCampaignSummary.appendChild(details);
    }
  }
  for (const attempt of attempts.filter((item) => item.error)) {
    const error = document.createElement("span");
    error.className = "evaluation-attempt-error";
    error.textContent = `${attempt.question_id}: ${attempt.error}`;
    evaluationCampaignSummary.appendChild(error);
  }
}

async function loadEvaluationAttemptEvents(campaign) {
  if (!evaluationLiveFeed) return;
  const activeAttempts = (campaign?.attempts || []).filter((item) => ["runtime_starting", "running"].includes(item.status));
  evaluationLiveFeed.textContent = activeAttempts.length
    ? `${activeAttempts.length} agent session${activeAttempts.length === 1 ? "" : "s"} running. Open an attempt to view its standard session stream.`
    : "";
}

function openEvaluationAttempt(campaign, attempt) {
  if (!attempt.runtime_session_id) return;
  setApplicationMode("workspace");
  void switchSession(attempt.runtime_session_id, campaign.owner_id || state.userId);
}

async function loadEvaluationCampaign(campaignId) {
  if (!state.userId || !campaignId) return;
  try {
    const response = await fetch(`/api/evaluations/campaigns/${encodeURIComponent(campaignId)}?user_id=${encodeURIComponent(state.userId)}`);
    const campaign = await response.json();
    if (!response.ok) throw new Error(campaign.detail || `HTTP ${response.status}`);
    state.activeEvaluationCampaign = campaign;
    renderEvaluationCampaign(campaign);
    await loadEvaluationAttemptEvents(campaign);
    setEvaluationStatus("");
  } catch (error) {
    setEvaluationStatus(`Could not load campaign: ${error.message}`, true);
  }
}

async function loadEvaluationCampaigns() {
  if (!state.userId || !evaluationCampaignList) return;
  try {
    const response = await fetch(`/api/evaluations/campaigns?user_id=${encodeURIComponent(state.userId)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || `HTTP ${response.status}`);
    evaluationCampaignList.innerHTML = "";
    for (const campaign of data.campaigns || []) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "evaluation-campaign-row";
      button.textContent = `${campaign.model_name} · ${campaign.status}`;
      button.addEventListener("click", () => void loadEvaluationCampaign(campaign.campaign_id));
      evaluationCampaignList.appendChild(button);
    }
    if (!evaluationCampaignList.childElementCount) {
      evaluationCampaignList.textContent = "No campaigns yet";
    }
    setEvaluationStatus("");
  } catch (error) {
    setEvaluationStatus(`Could not load campaigns: ${error.message}`, true);
  }
}

async function cancelEvaluationCampaign(campaign) {
  if (!state.userId || !campaign?.campaign_id) return;
  setEvaluationStatus("Cancelling evaluation");
  try {
    const response = await fetch(
      `/api/evaluations/campaigns/${encodeURIComponent(campaign.campaign_id)}/cancel?user_id=${encodeURIComponent(state.userId)}`,
      { method: "POST" },
    );
    const data = await response.json();
    if (!response.ok) throw new Error(apiErrorMessage(data, `HTTP ${response.status}`));
    state.activeEvaluationCampaign = data;
    renderEvaluationCampaign(data);
    setEvaluationStatus("Evaluation cancellation requested");
    await loadEvaluationCampaigns();
  } catch (error) {
    setEvaluationStatus(`Could not cancel evaluation: ${error.message}`, true);
  }
}

async function createAndStartEvaluation() {
  if (!state.userId) {
    setEvaluationStatus("Sign in before starting an evaluation", true);
    return;
  }
  const questionIds = [...state.selectedEvaluationQuestions];
  if (!questionIds.length) {
    setEvaluationStatus("Select at least one question", true);
    return;
  }
  if (questionIds.some((questionId) => typeof questionId !== "string" || !questionId.trim())) {
    setEvaluationStatus("Selected question data is invalid. Refresh the catalog and select again.", true);
    return;
  }
  const valueOf = (id, label) => {
    const value = Number(document.getElementById(id)?.value);
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${label} must be a positive integer`);
    }
    return value;
  };
  let maxParallelism;
  let maxTurns;
  let timeoutSeconds;
  try {
    maxParallelism = valueOf("evaluation-parallelism", "Parallelism");
    maxTurns = valueOf("evaluation-turns", "Max turns");
    timeoutSeconds = valueOf("evaluation-timeout", "Timeout");
  } catch (error) {
    setEvaluationStatus(error.message, true);
    return;
  }
  const body = {
    model_name: document.getElementById("evaluation-model")?.value.trim() || "matcreator",
    question_ids: questionIds,
    max_parallelism: maxParallelism,
    max_turns: maxTurns,
    timeout_seconds: timeoutSeconds,
    flash: false,
  };
  setEvaluationStatus("Creating campaign");
  try {
    const createResponse = await fetch(`/api/evaluations/campaigns?user_id=${encodeURIComponent(state.userId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const campaign = await createResponse.json();
    if (!createResponse.ok) throw new Error(apiErrorMessage(campaign, `HTTP ${createResponse.status}`));
    const startResponse = await fetch(`/api/evaluations/campaigns/${encodeURIComponent(campaign.campaign_id)}/start?user_id=${encodeURIComponent(state.userId)}`, { method: "POST" });
    const started = await startResponse.json();
    if (!startResponse.ok) throw new Error(apiErrorMessage(started, `HTTP ${startResponse.status}`));
    state.activeEvaluationCampaign = { ...started, attempts: [] };
    renderEvaluationCampaign(state.activeEvaluationCampaign);
    await loadEvaluationCampaigns();
    setEvaluationStatus("Evaluation queued");
  } catch (error) {
    setEvaluationStatus(`Could not start evaluation: ${error.message}`, true);
  }
}

function setApplicationMode(mode) {
  const evaluation = mode === "evaluation";
  state.appMode = evaluation ? "evaluation" : "workspace";
  workspaceModeBtn?.classList.toggle("active", !evaluation);
  evaluationModeBtn?.classList.toggle("active", evaluation);
  workspaceModeBtn?.setAttribute("aria-pressed", String(!evaluation));
  evaluationModeBtn?.setAttribute("aria-pressed", String(evaluation));
  evaluationPane?.classList.toggle("hidden", !evaluation);
  evaluationTab?.classList.toggle("hidden", !evaluation);
  evaluationTabPanel?.classList.toggle("hidden", !evaluation);
  document.querySelectorAll(".sessions-pane, .remote-jobs-pane, .file-explorer-col").forEach((element) => {
    element.classList.toggle("hidden", evaluation);
  });
  if (evaluation) {
    activateCenterTab("evaluation");
    void loadEvaluationCatalog();
    void loadEvaluationCampaigns();
    void loadEvaluationQuestionSets();
    void loadEvaluationGeneratedQuestions();
    if (!evaluationPoll) {
      evaluationPoll = setInterval(() => {
        if (state.activeEvaluationCampaign?.campaign_id && ["draft", "starting", "active", "cancelling"].includes(state.activeEvaluationCampaign.status)) {
          void loadEvaluationCampaign(state.activeEvaluationCampaign.campaign_id);
        }
        void loadEvaluationCampaigns();
      }, 2000);
    }
  } else {
    activateCenterTab("chat");
    if (evaluationPoll) {
      clearInterval(evaluationPoll);
      evaluationPoll = null;
    }
  }
}

workspaceModeBtn?.addEventListener("click", () => setApplicationMode("workspace"));
evaluationModeBtn?.addEventListener("click", () => setApplicationMode("evaluation"));
document.getElementById("evaluation-refresh-catalog")?.addEventListener("click", () => void loadEvaluationCatalog());
document.getElementById("evaluation-refresh-campaigns")?.addEventListener("click", () => void loadEvaluationCampaigns());
document.getElementById("evaluation-refresh-question-sets")?.addEventListener("click", () => void loadEvaluationQuestionSets());
document.getElementById("evaluation-refresh-generated-questions")?.addEventListener("click", () => void loadEvaluationGeneratedQuestions());
document.getElementById("evaluation-create-start")?.addEventListener("click", () => void createAndStartEvaluation());
document.getElementById("evaluation-question-set-select")?.addEventListener("change", (event) => loadSelectedQuestionSet(event.target.value));
document.getElementById("evaluation-save-question-set")?.addEventListener("click", () => void saveEvaluationQuestionSet());
document.getElementById("evaluation-update-question-set")?.addEventListener("click", () => void saveEvaluationQuestionSet(true));
document.getElementById("evaluation-delete-question-set")?.addEventListener("click", () => void deleteEvaluationQuestionSet());
document.getElementById("evaluation-clear-selection")?.addEventListener("click", () => {
  state.selectedEvaluationQuestions.clear();
  state.activeEvaluationQuestionSetId = "";
  renderEvaluationQuestions();
  renderEvaluationQuestionSets();
});
["evaluation-search", "evaluation-domain", "evaluation-capability", "evaluation-task-type"].forEach((id) => {
  document.getElementById(id)?.addEventListener("change", () => void loadEvaluationCatalog());
});
document.getElementById("evaluation-selected-only")?.addEventListener("change", renderEvaluationQuestions);

// ---------------------------------------------------------------------------
// Agent Graph Visualization
// ---------------------------------------------------------------------------

const stepExecutionFeed = new StepExecutionFeed({
  chatArea,
  isSending: () => Boolean(activeSessionRequest()),
  isChatNearBottom,
  scrollToBottom,
  createAgentAvatarEl,
  stepFeedTitle,
  formatStepDuration,
  renderStepInput,
  renderStepConversationEvent,
  renderStepToolCall,
  requestStepCancellation,
  createArtifactListItem,
});
const agentGraph = new AgentGraphView("agent-graph", {
  stepExecutionFeed,
  graphViewport,
  requestStepCancellation,
  createArtifactListItem,
  createJsonBlock,
  getStructurePaths,
  createStructureViewButton,
  syncPanelResizerVisibility: () => layoutController.syncPanelResizerVisibility(),
});
const planGraph = new ExecutionPlanView("plan-graph-canvas", {
  toggleButton: document.getElementById("plan-graph-toggle"),
  thumbnailElement: document.getElementById("plan-graph-thumbnail"),
  onNewGraph: () => showPlanGraph(),
});
const layoutController = createLayoutController({
  getUserId: () => state.userId,
  onLayoutChanged: () => agentGraph.notifyLayoutChanged(),
  elements: {
    graphResizer: document.getElementById("graph-resizer"),
    graphColumn: document.getElementById("graph-column"),
    sidePanel: document.getElementById("side-panel"),
    fileExplorerCol: document.getElementById("file-explorer-col"),
    colResizerGraph: document.getElementById("col-resizer-graph"),
    colResizerSide: document.getElementById("col-resizer-side"),
    colResizerFiles: document.getElementById("col-resizer-files"),
  },
});

async function requestStepCancellation(stepNumber) {
  if (stepNumber === undefined || stepNumber === null) return false;
  try {
    const resp = await fetch(`/api/sessions/${state.sessionId}/cancel-step/${stepNumber}`, { method: "POST" });
    return resp.ok;
  } catch (_) {
    return false;
  }
}

function shouldRefreshPlanGraphForTool(toolName) {
  return toolName === "validate_graph" || toolName === "validate_plan";
}

function newSessionId() {
  const randomPart = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
  return `session-${Date.now()}-${randomPart}`;
}

function sessionRequestKey(sessionId = state.sessionId, owner = state.activeSessionUserId || state.userId) {
  return `${owner || "user"}:${sessionId || ""}`;
}

function activeSessionRequest() {
  return state.activeRequests.get(sessionRequestKey());
}

function releaseSessionRequest(request) {
  if (!request) return;
  const current = state.activeRequests.get(request.key);
  if (current === request) {
    state.activeRequests.delete(request.key);
  }
  if (request.key === sessionRequestKey()) {
    updateSendButtonState();
  }
}

function updateSendButtonState() {
  const running = Boolean(activeSessionRequest());
  if (!sendBtn) return;
  sendBtn.textContent = running ? "■" : "➜";
  sendBtn.title = running ? "Stop" : "Send";
  sendBtn.classList.toggle("is-stopping", running);
}

function managedRunEventsUrl(request) {
  return `/api/runs/${request.runId}/events` + `?after=${request.lastSequence}`;
}

// ---------------------------------------------------------------------------
// Plan graph popup toggle
// ---------------------------------------------------------------------------

const planGraphPopup = document.getElementById("plan-graph-popup");
const planGraphToggleBtn = document.getElementById("plan-graph-toggle");
const planGraphThumbnailEl = document.getElementById("plan-graph-thumbnail");
const planGraphCloseBtn = document.getElementById("plan-graph-close");

function showPlanGraph() {
  planGraphPopup?.classList.remove("hidden");
  planGraphToggleBtn?.classList.add("is-open");
  planGraphToggleBtn?.setAttribute("aria-pressed", "true");
  planGraphToggleBtn?.setAttribute("title", "Close roadmap");
  planGraphToggleBtn?.setAttribute("aria-label", "Close roadmap");
  requestAnimationFrame(() => {
    planGraph.notifyLayoutChanged();
    planGraph.fitToView();
  });
}

function hidePlanGraph() {
  planGraphPopup?.classList.add("hidden");
  planGraphToggleBtn?.classList.remove("is-open");
  planGraphToggleBtn?.setAttribute("aria-pressed", "false");
  planGraphToggleBtn?.setAttribute("title", "Open roadmap");
  planGraphToggleBtn?.setAttribute("aria-label", "Open roadmap");
}

planGraphToggleBtn?.addEventListener("click", () => {
  if (planGraphPopup?.classList.contains("hidden")) {
    showPlanGraph();
  } else {
    hidePlanGraph();
  }
});

planGraphCloseBtn?.addEventListener("click", hidePlanGraph);
document.getElementById("plan-graph-zoom-in")?.addEventListener("click", () => planGraph.zoomIn());
document.getElementById("plan-graph-zoom-out")?.addEventListener("click", () => planGraph.zoomOut());
document.getElementById("plan-graph-fit")?.addEventListener("click", () => planGraph.fitToView());
document.getElementById("plan-graph-prev")?.addEventListener("click", () => planGraph.goPrev());
document.getElementById("plan-graph-next")?.addEventListener("click", () => planGraph.goNext());
// ---------------------------------------------------------------------------

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

// ---------------------------------------------------------------------------
// Login / username management
// ---------------------------------------------------------------------------

function _isUuid(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function _isValidIdentity(s) {
  return s === "user" || _isUuid(s);
}

function showLoginModal() {
  if (state.deploymentMode !== "server") {
    hideLoginModal();
    return;
  }
  loginModal.classList.remove("hidden");
  loginView.classList.remove("hidden");
  registerView.classList.add("hidden");
  loginInput.value = state.displayName || "";
  loginPassword.value = "";
  loginError.textContent = "";
  loginUuidDisplay.textContent = state.userId ? `UUID: ${state.userId}` : "";
  // Hide register link when already logged in — log out first to register a new account.
  const registerLink = document.getElementById("switch-to-register")?.parentElement;
  if (registerLink) registerLink.style.display = state.userId ? "none" : "";
  loginInput.focus();
}

async function logout() {
  const userId = state.userId;
  const deploymentMode = state.deploymentMode;
  if (deploymentMode === "server" && userId) {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId }),
      });
    } catch (_) { /* best-effort worker shutdown */ }
  }
  state.userId = "";
  state.displayName = "";
  state.activeSessionUserId = "";
  state.isAdmin = false;
  state.sessionReady = false;
  localStorage.removeItem("mat_userId");
  localStorage.removeItem("mat_displayName");
  localStorage.removeItem("mat_sessionId");
  localStorage.removeItem("mat_deploymentMode");
  userDisplay.textContent = "—";
  chatArea.innerHTML = "";
  stepExecutionFeed.reset();
  sessionListEl.innerHTML = '<li class="empty">Sign in to see sessions</li>';
  renderSessionFilesTree([]);
  clearCurrentUploads();
  agentGraph.reset();
  planGraph.reset();
  hidePlanGraph();
  settingsController.close();
  showLoginModal();
}

function showRegisterModal() {
  loginModal.classList.remove("hidden");
  loginView.classList.add("hidden");
  registerView.classList.remove("hidden");
  regInput.value = "";
  regPassword.value = "";
  regConfirm.value = "";
  regError.textContent = "";
  regInput.focus();
}

function hideLoginModal() {
  loginModal.classList.add("hidden");
}

function renderUserDisplay() {
  const label = state.displayName || state.userId;
  userDisplay.textContent = state.isAdmin ? `${label} (admin)` : label;
}

function canWriteActiveSession() {
  return state.deploymentMode === "local" || !state.activeSessionUserId || state.activeSessionUserId === state.userId;
}

function activeSessionBackendUserId() {
  return state.deploymentMode === "local"
    ? (state.activeSessionUserId || state.userId)
    : state.userId;
}

async function refreshAccess() {
  state.isAdmin = false;
  if (!state.userId) return;
  try {
    const resp = await fetch(`/api/session-access/${encodeURIComponent(state.userId)}`);
    if (!resp.ok) return;
    const access = await resp.json();
    state.isAdmin = Boolean(access.is_admin);
  } catch (_) {
    state.isAdmin = false;
  }
}

function _applySession(result) {
  state.userId = result.user_id;
  state.displayName = result.display_name;
  state.activeSessionUserId = result.user_id;
  state.sessionId = newSessionId();
  state.sessionReady = false;
  state.isAdmin = Boolean(result.is_admin);
  loginUuidDisplay.textContent = `UUID: ${result.user_id}`;
  localStorage.setItem("mat_deploymentMode", state.deploymentMode);
  localStorage.setItem("mat_userId", result.user_id);
  localStorage.setItem("mat_displayName", result.display_name);
  localStorage.setItem("mat_sessionId", state.sessionId);
  sessionIdEl.textContent = state.sessionId;
  chatArea.innerHTML = "";
  stepExecutionFeed.reset();
  renderSessionFilesTree([]);
  clearCurrentUploads();
  agentGraph.reset();
  planGraph.reset();
  hidePlanGraph();
  renderUserDisplay();
  hideLoginModal();
  layoutController.refresh();
  loadSessions();
}

async function applyLogin(displayName, password = null) {
  loginError.textContent = "";
  let result;
  try {
    const resp = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display_name: displayName, password }),
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      loginError.textContent = body.detail || `Login failed (${resp.status})`;
      return;
    }
    result = body;
  } catch (err) {
    loginError.textContent = `Login failed: ${err.message}`;
    return;
  }
  _applySession(result);
}

async function applyRegister(displayName, password, confirm) {
  regError.textContent = "";
  if (password !== confirm) {
    regError.textContent = "Passwords do not match.";
    return;
  }
  let result;
  try {
    const resp = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display_name: displayName, password }),
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      regError.textContent = body.detail || `Registration failed (${resp.status})`;
      return;
    }
    result = body;
  } catch (err) {
    regError.textContent = `Registration failed: ${err.message}`;
    return;
  }
  _applySession(result);
}

loginSubmit.addEventListener("click", () => {
  const name = loginInput.value.trim();
  if (name) applyLogin(name, loginPassword.value || null);
});

loginInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") loginPassword.focus();
});

loginPassword.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const name = loginInput.value.trim();
    if (name) applyLogin(name, loginPassword.value || null);
  }
});

regSubmit.addEventListener("click", () => {
  const name = regInput.value.trim();
  if (name) applyRegister(name, regPassword.value, regConfirm.value);
});

regInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") regPassword.focus();
});

regPassword.addEventListener("keydown", (e) => {
  if (e.key === "Enter") regConfirm.focus();
});

regConfirm.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const name = regInput.value.trim();
    if (name) applyRegister(name, regPassword.value, regConfirm.value);
  }
});

switchToRegister.addEventListener("click", () => showRegisterModal());
switchToLogin.addEventListener("click", () => showLoginModal());

editUserBtn.addEventListener("click", () => showLoginModal());
logoutBtn.addEventListener("click", () => logout());
settingsLogoutBtn.addEventListener("click", () => logout());

const savePasswordBtn = document.getElementById("settings-save-password-btn");
const passwordMsg = document.getElementById("settings-password-msg");
const settingsPasswordSection = savePasswordBtn?.parentElement;

async function savePassword() {
  const oldPw = document.getElementById("settings-current-password").value || null;
  const newPw = document.getElementById("settings-new-password").value;
  const confirmPw = document.getElementById("settings-confirm-password").value;
  passwordMsg.style.color = "#f87171";
  if (!newPw) { passwordMsg.textContent = "New password cannot be empty."; return; }
  if (newPw !== confirmPw) { passwordMsg.textContent = "Passwords do not match."; return; }
  try {
    const res = await fetch("/api/auth/set-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: state.userId, old_password: oldPw, new_password: newPw }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      passwordMsg.textContent = data.detail || "Failed to update password.";
      return;
    }
    passwordMsg.style.color = "#4ade80";
    passwordMsg.textContent = "Password updated.";
    document.getElementById("settings-current-password").value = "";
    document.getElementById("settings-new-password").value = "";
    document.getElementById("settings-confirm-password").value = "";
    setTimeout(() => { passwordMsg.textContent = ""; }, 3000);
  } catch (e) {
    passwordMsg.textContent = "Network error.";
  }
}

savePasswordBtn.addEventListener("click", savePassword);

function clearStoredIdentity() {
  localStorage.removeItem("mat_userId");
  localStorage.removeItem("mat_displayName");
  localStorage.removeItem("mat_sessionId");
}

function applyLocalIdentity(resetSession = false) {
  state.deploymentMode = "local";
  state.userId = "user";
  state.displayName = "user";
  state.activeSessionUserId = "user";
  state.isAdmin = false;
  state.sessionReady = false;
  if (resetSession) {
    state.sessionId = newSessionId();
    localStorage.setItem("mat_sessionId", state.sessionId);
  }
  localStorage.setItem("mat_deploymentMode", "local");
  localStorage.setItem("mat_userId", "user");
  localStorage.setItem("mat_displayName", "user");
}

function hideLocalAuthControls() {
  if (editUserBtn) editUserBtn.style.display = "none";
  if (logoutBtn) logoutBtn.style.display = "none";
  if (settingsLogoutBtn) settingsLogoutBtn.style.display = "none";
  if (settingsPasswordSection) settingsPasswordSection.style.display = "none";
}

// On load: in local mode force passwordless "user"; in server mode require server auth.
(async () => {
  let serverMode = "local";
  try {
    const healthResp = await fetch("/api/health");
    if (healthResp.ok) {
      const health = await healthResp.json();
      serverMode = health.mode || "local";
    }
  } catch (_) { /* server not up yet — assume local */ }

  state.deploymentMode = serverMode === "server" ? "server" : "local";
  const storedMode = localStorage.getItem("mat_deploymentMode") || "";
  const storedId = localStorage.getItem("mat_userId") || "";

  if (state.deploymentMode === "local") {
    hideLocalAuthControls();
    applyLocalIdentity(storedMode === "server" || (storedId && storedId !== "user"));
    hideLoginModal();
  } else if ((storedMode && storedMode !== "server") || (!storedMode && storedId === "user")) {
    clearStoredIdentity();
    showLoginModal();
    return;
  } else if (!storedId) {
    showLoginModal();
    return;
  } else if (!_isValidIdentity(storedId)) {
    // Legacy: localStorage contains a raw display name (non-"user"). Show login modal.
    showLoginModal();
    return;
  }

  sessionIdEl.textContent = state.sessionId;
  await refreshAccess();
  renderUserDisplay();
  await loadSessions();
  // Don't auto-restore previous session on page load — start fresh
  // User can click a session in the sidebar to switch to it
  localStorage.removeItem("mat_sessionId");
})();

// ---------------------------------------------------------------------------
// Session list management
// ---------------------------------------------------------------------------

async function loadSessions() {
  if (!state.userId) return;
  try {
    const resp = state.isAdmin
      ? await fetch(`/api/admin/sessions?user_id=${encodeURIComponent(state.userId)}`)
      : await fetch(`/api/users/${encodeURIComponent(state.userId)}/sessions`);
    if (!resp.ok) return;
    const sessions = await resp.json();
    renderSessionList(sessions);
  } catch (_) {
    // silently ignore — server may not be running yet
  }
}

function renderSessionList(sessions) {
  renderSessionList._lastSessions = sessions;
  sessionListEl.innerHTML = "";
  if (!Array.isArray(sessions) || !sessions.length) {
    sessionListEl.innerHTML = '<li class="empty">No sessions yet</li>';
    return;
  }
  sessions
    .slice()
    .filter((session) => state.sessionStatusFilter === "all" || sessionDisplayStatus(session, session.userId || state.userId) === state.sessionStatusFilter)
    .sort((a, b) => (b.lastUpdateTime || 0) - (a.lastUpdateTime || 0))
    .forEach((s) => {
      const li = document.createElement("li");
      const owner = s.userId || state.userId;
      const isActive = s.id === state.sessionId && owner === state.activeSessionUserId;
      const status = sessionDisplayStatus(s, owner);
      li.className = "session-item" + (isActive ? " active" : "");
      li.dataset.owner = owner;

      const content = document.createElement("div");
      content.className = "session-item-content";
      const sessionLabel = state.isAdmin ? `${owner} / ${s.id}` : s.id;
      const summary = s.summary || state.sessionSummaries[s.id];

      const idLine = document.createElement("div");
      idLine.className = "session-item-id";
      idLine.textContent = sessionLabel;
      const statusIndicator = document.createElement("span");
      statusIndicator.className = `session-status-indicator status-${status}`;
      statusIndicator.title = status;
      idLine.prepend(statusIndicator);

      if (summary) {
        li.classList.add("has-summary");
        const summaryLine = document.createElement("div");
        summaryLine.className = "session-item-summary";
        summaryLine.textContent = summary;
        content.appendChild(summaryLine);
        content.appendChild(idLine);
      } else {
        content.appendChild(idLine);
      }
      li.appendChild(content);

      const logBtn = document.createElement("button");
      logBtn.className = "session-item-log";
      logBtn.textContent = "LOG JSON";
      logBtn.title = "Download full session log";
      logBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        downloadSessionLog(s.id, owner);
      });
      li.appendChild(logBtn);

      const draftBtn = document.createElement("button");
      draftBtn.className = "session-item-draft";
      draftBtn.textContent = "GENERATE";
      draftBtn.title = "Generate a staged benchmark question from this session";
      draftBtn.disabled = status === "running";
      draftBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void showEvaluationQuestionDraft(s.id, owner);
      });
      li.appendChild(draftBtn);

      const delBtn = document.createElement("button");
      delBtn.className = "session-item-delete";
      delBtn.textContent = "×";
      delBtn.title = "Delete session";
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteSession(s.id);
      });
      li.appendChild(delBtn);

      li.title = summary ? `${summary}\n${sessionLabel}` : sessionLabel;
      li.addEventListener("click", () => switchSession(s.id, owner));
      sessionListEl.appendChild(li);
    });
}

function sessionDisplayStatus(session, owner) {
  if (state.activeRequests.get(sessionRequestKey(session.id, owner))) return "running";
  if (session.id === state.sessionId && owner === state.activeSessionUserId) {
    const statuses = state.remoteJobs.map((job) => job.status);
    if (statuses.includes("running") || statuses.includes("queued")) return "running";
  }
  const status = String(session.status || session.phase || "").toLowerCase();
  return ["running", "idle"].includes(status) ? status : "idle";
}

async function switchSession(sessionId, owner = state.userId) {
  const viewKey = sessionRequestKey(sessionId, owner);
  state.sessionId = sessionId;
  state.activeSessionUserId = owner;
  state.sessionReady = true;
  localStorage.setItem("mat_sessionId", sessionId);
  sessionIdEl.textContent = sessionId;
  const cachedView = state.sessionViewCache.get(viewKey);
  if (cachedView) renderSessionSnapshot(cachedView);
  else renderSessionFilesTree([]);
  clearCurrentUploads();
  agentGraph.reset();
  planGraph.reset();
  hidePlanGraph();
  startRemoteJobsPolling(sessionId, owner);
  const [activeRun] = await Promise.all([
    discoverManagedRun(sessionId, owner),
    loadSession(sessionId, owner),
    loadRemoteJobs(sessionId, owner),
  ]);
  if (activeRun) startManagedRunReconnect(activeRun, sessionId, owner);
  void loadSessions();
  agentGraph.startPolling(sessionId);
  planGraph.startPolling(sessionId);
}

function remoteJobsUrl(sessionId, owner) {
  return `/api/sessions/${encodeURIComponent(sessionId)}/remote-jobs?user_id=${encodeURIComponent(owner)}`;
}

function startRemoteJobsPolling(sessionId, owner) {
  if (remoteJobsPoll) clearInterval(remoteJobsPoll);
  remoteJobsPoll = setInterval(() => void loadRemoteJobs(sessionId, owner), 15000);
}

async function loadRemoteJobs(sessionId = state.sessionId, owner = state.activeSessionUserId || state.userId) {
  if (!sessionId || !owner) return;
  try {
    const response = await fetch(remoteJobsUrl(sessionId, owner));
    if (!response.ok) return;
    const data = await response.json();
    if (sessionId !== state.sessionId || owner !== state.activeSessionUserId) return;
    state.remoteJobs = Array.isArray(data.jobs) ? data.jobs : [];
    renderRemoteJobs();
  } catch (_) {
    // The control plane may be restarting; retain the last visible snapshot.
  }
}

function renderRemoteJobs() {
  if (!remoteJobListEl) return;
  remoteJobListEl.innerHTML = "";
  if (!state.remoteJobs.length) {
    remoteJobListEl.innerHTML = '<li class="empty">No remote jobs in this session</li>';
    return;
  }
  for (const job of state.remoteJobs) {
    const item = document.createElement("li");
    const providerStatus = job.snapshot?.provider_status;
    const lifecycle = remoteJobLifecycle(job.status);
    item.className = `remote-job status-${lifecycle.key}`;
    const header = document.createElement("div");
    header.className = "remote-job-header";
    const provider = document.createElement("span");
    provider.className = "remote-job-provider";
    provider.textContent = job.provider || "remote";
    const status = document.createElement("span");
    status.className = "remote-job-status";
    status.textContent = lifecycle.label;
    header.append(provider, status, createRemoteJobActions(job));
    const identifier = document.createElement("div");
    identifier.className = "remote-job-id";
    identifier.textContent = job.external_id || job.job_id;
    item.append(header, identifier);
    if (providerStatus) {
      const providerDetail = document.createElement("div");
      providerDetail.className = "remote-job-provider-detail";
      providerDetail.textContent = `Sandbox: ${providerStatus}`;
      item.appendChild(providerDetail);
    }
    if (job.error) {
      const error = document.createElement("div");
      error.className = "remote-job-error";
      error.textContent = job.error;
      item.appendChild(error);
    }
    remoteJobListEl.appendChild(item);
  }
}

function remoteJobLifecycle(status) {
  const normalized = String(status || "unknown").toLowerCase();
  const labels = {
    created: "Created",
    submitting: "Submitting",
    queued: "Queued",
    running: "Running",
    pause_requested: "Pausing",
    paused: "Paused",
    resume_requested: "Resuming",
    resuming: "Resuming",
    succeeded: "Completed",
    collecting: "Collecting results",
    collected: "Completed",
    terminate_requested: "Terminating",
    terminated: "Terminated",
    failed: "Failed",
    cancelled: "Cancelled",
    lost: "Lost",
  };
  return { key: normalized, label: labels[normalized] || "Unknown" };
}

function setRemoteJobsExpanded(expanded) {
  state.remoteJobsExpanded = Boolean(expanded);
  remoteJobListEl?.classList.toggle("hidden", !state.remoteJobsExpanded);
  remoteJobsToggleBtn?.setAttribute("aria-expanded", String(state.remoteJobsExpanded));
  remoteJobsToggleBtn?.classList.toggle("is-expanded", state.remoteJobsExpanded);
  remoteJobsPane?.classList.toggle("is-expanded", state.remoteJobsExpanded);
}

function createRemoteJobActions(job) {
  const actions = document.createElement("div");
  actions.className = "remote-job-actions";
  const active = ["queued", "running", "submitting", "resuming"].includes(job.status);
  const refresh = document.createElement("button");
  refresh.className = "remote-job-action";
  refresh.textContent = "↺";
  refresh.title = "Refresh sandbox status";
  refresh.addEventListener("click", () => void controlRemoteJob(job, "refresh", refresh));
  const pause = document.createElement("button");
  pause.className = "remote-job-action";
  pause.textContent = "Ⅱ";
  pause.title = "Pause sandbox";
  pause.disabled = !active;
  pause.addEventListener("click", () => void controlRemoteJob(job, "pause", pause));
  const terminate = document.createElement("button");
  terminate.className = "remote-job-action terminate";
  terminate.textContent = "■";
  terminate.title = "Terminate sandbox";
  terminate.disabled = !active && job.status !== "paused";
  terminate.addEventListener("click", () => void controlRemoteJob(job, "terminate", terminate));
  actions.append(refresh, pause, terminate);
  return actions;
}

async function controlRemoteJob(job, action, button) {
  const owner = state.activeSessionUserId || state.userId;
  if (!owner || !job?.job_id) return;
  button.disabled = true;
  try {
    const url = `/api/sessions/${encodeURIComponent(state.sessionId)}/remote-jobs/${encodeURIComponent(job.job_id)}/${action}?user_id=${encodeURIComponent(owner)}`;
    const response = await fetch(url, { method: "POST" });
    if (response.ok) await loadRemoteJobs(state.sessionId, owner);
  } finally {
    button.disabled = false;
  }
}

refreshRemoteJobsBtn?.addEventListener("click", () => void loadRemoteJobs());
remoteJobsToggleBtn?.addEventListener("click", () => setRemoteJobsExpanded(!state.remoteJobsExpanded));

// ---------------------------------------------------------------------------
// Confirm dialog & session delete
// ---------------------------------------------------------------------------

function showConfirmDialog(message) {
  const existing = document.querySelector(".confirm-overlay");
  if (existing) existing.remove();

  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => { if (settled) return; settled = true; overlay.remove(); resolve(result); };

    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    const msg = document.createElement("p");
    msg.className = "confirm-message";
    msg.innerHTML = message;

    const actions = document.createElement("div");
    actions.className = "confirm-actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "confirm-cancel";
    cancelBtn.textContent = "Cancel";
    cancelBtn.onclick = () => done(false);
    const okBtn = document.createElement("button");
    okBtn.className = "confirm-ok";
    okBtn.textContent = "Delete";
    okBtn.onclick = () => done(true);
    actions.append(cancelBtn, okBtn);

    const card = document.createElement("div");
    card.className = "confirm-card";
    card.append(msg, actions);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    overlay.addEventListener("click", (e) => { if (e.target === overlay) done(false); });
    overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") done(false); });
    okBtn.focus();
  });
}

async function deleteSession(sessionId) {
  if (activeSessionRequest()) return;
  if (!await showConfirmDialog(`Delete session ${sessionId}? This cannot be undone.`)) return;
  try {
    const resp = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    if (!resp.ok) return;
    if (sessionId === state.sessionId) {
      state.sessionId = newSessionId();
      state.activeSessionUserId = state.userId;
      state.sessionReady = false;
      localStorage.setItem("mat_sessionId", state.sessionId);
      sessionIdEl.textContent = state.sessionId;
      chatArea.innerHTML = "";
      stepExecutionFeed.reset();
      renderSessionFilesTree([]);
      clearCurrentUploads();
      agentGraph.reset();
      planGraph.reset();
      hidePlanGraph();
    }
    await loadSessions();
  } catch (_) {
    // silently ignore
  }
}

refreshSessionsBtn.addEventListener("click", (e) => { e.stopPropagation(); loadSessions(); });
sessionStatusFilter?.addEventListener("change", () => {
  state.sessionStatusFilter = sessionStatusFilter.value || "all";
  renderSessionList._lastSessions && renderSessionList(renderSessionList._lastSessions);
});

async function downloadSessionLog(sessionId, owner = state.userId) {
  if (!sessionId) return;
  const userQuery = owner || state.userId;
  const query = userQuery ? `?user_id=${encodeURIComponent(userQuery)}` : "";
  const url = `/api/sessions/${encodeURIComponent(sessionId)}/session-log${query}`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      const msg = await resp.text().catch(() => "");
      throw new Error(msg || `HTTP ${resp.status}`);
    }
    const blob = await resp.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = `matcreator-session-log-${sessionId}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);
  } catch (err) {
    console.warn("Failed to download session log", err);
  }
}

function showEvaluationQuestionDraftModal(draft, actionMessage = "") {
  const existing = document.querySelector(".evaluation-draft-overlay");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.className = "evaluation-draft-overlay";
  const card = document.createElement("section");
  card.className = "evaluation-draft-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-label", "Evaluation question draft");

  const header = document.createElement("header");
  header.className = "evaluation-draft-header";
  const heading = document.createElement("div");
  const eyebrow = document.createElement("div");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "Staged benchmark question";
  const title = document.createElement("h2");
  title.textContent = draft.question.id || "Generated question";
  heading.append(eyebrow, title);
  const close = document.createElement("button");
  close.className = "ghost";
  close.type = "button";
  close.textContent = "Close";
  close.addEventListener("click", () => overlay.remove());
  header.append(heading, close);

  const notice = document.createElement("p");
  notice.className = "evaluation-draft-notice";
  const statusNotices = {
    ready_for_review: "This draft is saved and ready for review. Approve it when the YAML is final.",
    invalid: "This saved draft has validation issues. Edit it manually or refine it with MatCreator feedback.",
    approved: "This draft is approved and saved. Export it to add it to the configured benchmark bank.",
    exported: "This draft has been exported to the configured benchmark bank and is now read-only.",
  };
  notice.textContent = statusNotices[draft.status] || "This question draft is saved for review.";
  const validation = document.createElement("div");
  const isValid = ["ready_for_review", "approved", "exported"].includes(draft.status);
  validation.className = `evaluation-draft-validation ${isValid ? "is-valid" : "is-invalid"}`;
  validation.textContent = isValid
    ? "Schema and executable-verifier checks passed"
    : "Validation issues";
  if (draft.validation_errors?.length) {
    const errors = document.createElement("ul");
    for (const message of draft.validation_errors) {
      const item = document.createElement("li");
      item.textContent = message;
      errors.appendChild(item);
    }
    validation.appendChild(errors);
  }
  const yamlHeading = document.createElement("h3");
  yamlHeading.textContent = "Generated question YAML";
  const yaml = document.createElement("textarea");
  yaml.className = "evaluation-draft-yaml";
  yaml.textContent = draft.question_yaml || "No YAML was returned.";
  yaml.value = draft.question_yaml || "";
  yaml.setAttribute("aria-label", "Generated question YAML");
  yaml.spellcheck = false;
  const actions = document.createElement("div");
  actions.className = "evaluation-draft-actions";
  const instruction = document.createElement("textarea");
  instruction.className = "evaluation-draft-instruction";
  instruction.rows = 2;
  instruction.maxLength = 2000;
  instruction.placeholder = "Optional refinement instruction";
  instruction.setAttribute("aria-label", "Optional refinement instruction");
  instruction.disabled = draft.status === "exported";
  const actionStatus = document.createElement("p");
  actionStatus.className = actionMessage
    ? "evaluation-draft-action-status is-success"
    : "evaluation-draft-action-status";
  actionStatus.setAttribute("role", "status");
  actionStatus.textContent = actionMessage;
  const buttons = [];
  const runDraftAction = async (path, options = {}, activeButton, pendingLabel, successLabel) => {
    actionStatus.className = "evaluation-draft-action-status";
    actionStatus.textContent = "";
    const originalLabel = activeButton.textContent;
    buttons.forEach((button) => { button.disabled = true; });
    instruction.disabled = true;
    card.setAttribute("aria-busy", "true");
    activeButton.textContent = pendingLabel;
    try {
      const response = await fetch(
        `/api/evaluation-question-drafts/${encodeURIComponent(draft.draft_id)}${path}?user_id=${encodeURIComponent(draft.evidence?.source?.owner_id || state.userId)}`,
        options,
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || `HTTP ${response.status}`);
      const savedPath = data.staging_path ? `${data.staging_path}/question.yaml` : "draft storage";
      if (state.appMode === "evaluation") void loadEvaluationGeneratedQuestions();
      showEvaluationQuestionDraftModal(data, `${successLabel} ${savedPath}`);
      return data;
    } catch (error) {
      activeButton.textContent = originalLabel;
      buttons.forEach((button) => { button.disabled = false; });
      save.disabled = draft.status === "exported";
      refine.disabled = draft.status === "exported";
      approve.disabled = draft.status === "exported";
      exportButton.disabled = draft.status !== "approved";
      instruction.disabled = draft.status === "exported";
      card.removeAttribute("aria-busy");
      actionStatus.className = "evaluation-draft-action-status is-error";
      actionStatus.textContent = error.message || "The action failed.";
      actionStatus.focus();
      return null;
    }
  };
  const save = document.createElement("button");
  save.type = "button";
  save.className = "ghost";
  save.textContent = "Save YAML";
  save.disabled = draft.status === "exported";
  save.addEventListener("click", () => void runDraftAction("", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question_yaml: yaml.value }),
  }, save, "Saving...", "Saved to"));
  actions.appendChild(save);
  const refine = document.createElement("button");
  refine.type = "button";
  refine.className = "ghost";
  refine.textContent = "Refine with feedback";
  refine.disabled = draft.status === "exported";
  refine.addEventListener("click", () => void (async () => {
    try {
      let current = draft;
      if (yaml.value !== draft.question_yaml) {
        current = await runDraftAction("", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question_yaml: yaml.value }),
        }, refine, "Saving...", "Saved to");
      }
      if (!current) return;
      await runDraftAction("/refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: instruction.value }),
      }, refine, "Refining...", "Refined and saved to");
    } catch (_error) {
      // runDraftAction renders the actionable error in the dialog.
    }
  })());
  actions.appendChild(refine);
  const approve = document.createElement("button");
  approve.type = "button";
  approve.className = "ghost";
  approve.textContent = draft.status === "approved" ? "Approved" : "Approve";
  approve.disabled = draft.status === "exported";
  approve.title = draft.status === "invalid"
    ? "Validate this saved YAML and show why it cannot be approved"
    : "Approve this saved YAML";
  approve.addEventListener("click", () => void runDraftAction(
    "/approve", { method: "POST" }, approve, "Approving...", "Approved and saved at",
  ));
  actions.appendChild(approve);
  const exportButton = document.createElement("button");
  exportButton.type = "button";
  exportButton.className = "evaluation-draft-export";
  exportButton.textContent = draft.status === "exported" ? "Exported" : "Export to benchmark bank";
  exportButton.disabled = draft.status !== "approved";
  exportButton.addEventListener("click", () => void runDraftAction(
    "/export", { method: "POST" }, exportButton, "Exporting...", "Exported from",
  ));
  actions.appendChild(exportButton);
  buttons.push(save, refine, approve, exportButton);
  const evidence = document.createElement("div");
  evidence.className = "evaluation-draft-evidence";
  const stepsHeading = document.createElement("h3");
  stepsHeading.textContent = "Observable session steps";
  evidence.appendChild(stepsHeading);
  const stepList = document.createElement("ol");
  for (const step of draft.evidence?.steps || []) {
    const item = document.createElement("li");
    item.textContent = `${step.action}${step.status ? ` [${step.status}]` : ""}${step.summary ? `: ${step.summary}` : ""}`;
    stepList.appendChild(item);
  }
  evidence.appendChild(stepList);
  const artifacts = document.createElement("p");
  artifacts.className = "evaluation-draft-artifacts";
  const artifactCount = draft.evidence?.artifacts?.length || 0;
  artifacts.textContent = `${artifactCount} source artifact${artifactCount === 1 ? "" : "s"} available for review.`;
  evidence.appendChild(artifacts);
  card.append(header, notice, validation, yamlHeading, yaml, instruction, actions, actionStatus, evidence);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  close.focus();
  overlay.addEventListener("click", (event) => { if (event.target === overlay) overlay.remove(); });
}

function showEvaluationQuestionDraftError(message) {
  const existing = document.querySelector(".evaluation-draft-overlay");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.className = "evaluation-draft-overlay";
  const card = document.createElement("section");
  card.className = "evaluation-draft-card";
  card.setAttribute("role", "alertdialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-label", "Question generation failed");
  const heading = document.createElement("h2");
  heading.textContent = "Question generation failed";
  const detail = document.createElement("p");
  detail.className = "evaluation-draft-notice";
  detail.textContent = message;
  const close = document.createElement("button");
  close.className = "ghost";
  close.type = "button";
  close.textContent = "Close";
  close.addEventListener("click", () => overlay.remove());
  card.append(heading, detail, close);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  close.focus();
  overlay.addEventListener("click", (event) => { if (event.target === overlay) overlay.remove(); });
}

function showEvaluationQuestionDraftGenerating() {
  const existing = document.querySelector(".evaluation-draft-overlay");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.className = "evaluation-draft-overlay";
  const card = document.createElement("section");
  card.className = "evaluation-draft-card evaluation-draft-generating";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-label", "Generating benchmark question");
  card.setAttribute("aria-busy", "true");
  const spinner = document.createElement("div");
  spinner.className = "evaluation-draft-spinner";
  spinner.setAttribute("aria-hidden", "true");
  const content = document.createElement("div");
  const heading = document.createElement("h2");
  heading.textContent = "Generating benchmark question";
  const detail = document.createElement("p");
  detail.className = "evaluation-draft-notice";
  detail.setAttribute("role", "status");
  detail.textContent = "Preparing session evidence and asking the configured MatCreator LLM for a reviewable draft.";
  content.append(heading, detail);
  card.append(spinner, content);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
}

async function showEvaluationQuestionDraft(sessionId, owner = state.userId) {
  const query = owner ? `?user_id=${encodeURIComponent(owner)}` : "";
  showEvaluationQuestionDraftGenerating();
  try {
    const response = await fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/evaluation-question-drafts${query}`,
      { method: "POST" },
    );
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.detail || `HTTP ${response.status}`);
    }
    showEvaluationQuestionDraftModal(await response.json());
  } catch (error) {
    console.warn("Failed to generate staged benchmark question", error);
    showEvaluationQuestionDraftError(error.message || "The server did not return a reason.");
  }
}

async function showSavedQuestionDrafts() {
  try {
    const response = await fetch(
      `/api/evaluation-question-drafts?user_id=${encodeURIComponent(state.userId)}`,
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.detail || `HTTP ${response.status}`);
    const overlay = document.createElement("div");
    overlay.className = "evaluation-draft-overlay";
    const card = document.createElement("section");
    card.className = "evaluation-draft-card evaluation-draft-list-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-label", "Saved evaluation question drafts");
    const header = document.createElement("header");
    header.className = "evaluation-draft-header";
    const heading = document.createElement("h2");
    heading.textContent = "Saved question drafts";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "ghost";
    close.textContent = "Close";
    close.addEventListener("click", () => overlay.remove());
    header.append(heading, close);
    const list = document.createElement("div");
    list.className = "evaluation-draft-list";
    const drafts = payload.drafts || [];
    if (!drafts.length) {
      const empty = document.createElement("p");
      empty.className = "evaluation-draft-notice";
      empty.textContent = "No saved question drafts yet.";
      list.appendChild(empty);
    }
    for (const draft of drafts) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "evaluation-draft-list-item";
      const title = document.createElement("strong");
      title.textContent = draft.question_id || "Untitled question";
      const meta = document.createElement("span");
      meta.textContent = `${draft.status} · session ${draft.source_session_id || "unknown"}`;
      row.append(title, meta);
      row.addEventListener("click", async () => {
        const loaded = await fetch(
          `/api/evaluation-question-drafts/${encodeURIComponent(draft.draft_id)}?user_id=${encodeURIComponent(state.userId)}`,
        );
        const data = await loaded.json().catch(() => ({}));
        if (!loaded.ok) {
          showEvaluationQuestionDraftError(data.detail || `HTTP ${loaded.status}`);
          return;
        }
        showEvaluationQuestionDraftModal(data);
      });
      list.appendChild(row);
    }
    card.append(header, list);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    close.focus();
    overlay.addEventListener("click", (event) => { if (event.target === overlay) overlay.remove(); });
  } catch (error) {
    showEvaluationQuestionDraftError(error.message || "Saved drafts could not be loaded.");
  }
}

document.getElementById("saved-question-drafts")?.addEventListener("click", () => {
  void showSavedQuestionDrafts();
});

document.getElementById("refresh-files").addEventListener("click", (e) => { e.stopPropagation(); refreshSessionFiles(); });

// ---------------------------------------------------------------------------
// File path → API URL conversion
// ---------------------------------------------------------------------------

function pathToApiUrl(path) {
  const sid = state.sessionId ? `&session_id=${encodeURIComponent(state.sessionId)}` : "";
  return `/api/workspace/files?path=${encodeURIComponent(path)}${sid}`;
}

// ---------------------------------------------------------------------------
// Chat helpers
// ---------------------------------------------------------------------------

// Post-process marked output: wrap ASCII art (box-drawing chars) in <pre>.
const BOX_RE = /[┌┐└┘├┤┬┴┼│━─]/;
function renderMarkdown(text) {
  if (!text) return "";
  let html = marked.parse(text);
  html = html.replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/gi, (match, inner) => {
    const decoded = inner.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    return BOX_RE.test(decoded) ? `<pre class="ascii-art">${decoded}</pre>` : match;
  });
  html = html.replace(/<p>([\s\S]*?)<\/p>/gi, (match, inner) => {
    const decoded = inner.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    return BOX_RE.test(decoded) ? `<pre class="ascii-art">${decoded}</pre>` : match;
  });
  return html;
}

// Unescape common escape sequences in text content.
// Converts literal \n, \t, \r, \\ to actual characters.
function unescapeText(text) {
  if (!text) return "";
  return text
    .replace(/\\\\/g, "\x00")    // protect literal backslashes
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r")
    .replace(/\\"/g, '"')
    .replace(/\x00/g, "\\");     // restore literal backslashes
}

// Cached character widths for wrap calculation (ASCII and CJK)
let _asciiWidth = 0;
let _cjkWidth = 0;
function getCharWidths() {
  if (_asciiWidth) return { ascii: _asciiWidth, cjk: _cjkWidth };
  const s = document.createElement("span");
  s.style.cssText = "position:absolute;visibility:hidden;font:14px 'Courier New',Consolas,monospace;white-space:pre;";
  document.body.appendChild(s);
  s.textContent = "x";
  _asciiWidth = s.getBoundingClientRect().width;
  s.textContent = "中";
  _cjkWidth = s.getBoundingClientRect().width;
  document.body.removeChild(s);
  return { ascii: _asciiWidth, cjk: _cjkWidth };
}

const CJK_RE = /[一-鿿㐀-䶿豈-﫿　-〿＀-￯]/;
function measureLine(line) {
  const { ascii, cjk } = getCharWidths();
  let w = 0;
  for (const ch of line) {
    w += CJK_RE.test(ch) ? cjk : ascii;
  }
  return w;
}

// Create a <pre class="json-block"> with unescaped content.
// Strips leading/trailing { } from JSON-like strings for cleaner display.
// Uses ResizeObserver to adapt wrap markers to container width.
function createJsonBlock(content) {
  const pre = document.createElement("pre");
  pre.className = "json-block";
  let rawText = unescapeText(content);
  rawText = rawText.replace(/^\{\s*/, "").replace(/\s*\}$/, "");
  pre.dataset.raw = rawText;
  applyWrapMarkers(pre);
  const ro = new ResizeObserver(() => applyWrapMarkers(pre));
  ro.observe(pre);
  return pre;
}

function applyWrapMarkers(pre) {
  const raw = pre.dataset.raw;
  if (!raw) return;
  const containerW = pre.clientWidth - 16; // subtract padding
  if (containerW <= 0) return;
  const { ascii, cjk } = getCharWidths();
  const markerW = ascii * 3; // " ↵" approx 3 ascii chars wide
  const lines = raw.split("\n");
  const out = [];
  for (const line of lines) {
    const lineW = measureLine(line);
    if (lineW <= containerW) {
      out.push(line);
    } else {
      // Split line by pixel width
      let w = 0, start = 0;
      for (let i = 0; i < line.length; i++) {
        const chW = CJK_RE.test(line[i]) ? cjk : ascii;
        if (w + chW > containerW - markerW) {
          out.push(line.slice(start, i) + " ↵");
          start = i;
          w = chW;
        } else {
          w += chW;
        }
      }
      if (start < line.length) out.push(line.slice(start));
    }
  }
  pre.textContent = out.join("\n");
}

const AGENT_AVATAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="rgba(125,211,252,0.9)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <rect x="3" y="8" width="18" height="11" rx="2"/>
  <path d="M8 8V6a4 4 0 0 1 8 0v2"/>
  <circle cx="9" cy="14" r="1" fill="rgba(125,211,252,0.9)" stroke="none"/>
  <circle cx="15" cy="14" r="1" fill="rgba(125,211,252,0.9)" stroke="none"/>
  <path d="M7 19v2M17 19v2"/>
</svg>`;

const USER_AVATAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="rgba(168,85,247,0.9)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="8" r="4"/>
  <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
</svg>`;

function getUserAvatar() {
  return localStorage.getItem("user-avatar-url") || null;
}

function setUserAvatar(dataUrl) {
  localStorage.setItem("user-avatar-url", dataUrl);
  document.querySelectorAll(".user-avatar").forEach(applyUserAvatarToEl);
}

function applyUserAvatarToEl(el) {
  const url = getUserAvatar();
  el.innerHTML = url ? `<img src="${url}" alt="User">` : USER_AVATAR_SVG;
}

function createAgentAvatarEl() {
  const el = document.createElement("div");
  el.className = "message-avatar agent-avatar";
  el.innerHTML = AGENT_AVATAR_SVG;
  return el;
}

function createUserAvatarEl() {
  const el = document.createElement("div");
  el.className = "message-avatar user-avatar";
  applyUserAvatarToEl(el);
  return el;
}

function scrollToBottom() {
  chatArea.scrollTop = chatArea.scrollHeight;
}

function isChatNearBottom() {
  return chatArea.scrollHeight - chatArea.scrollTop - chatArea.clientHeight < 80;
}

function appendLiveTurnChild(container, child) {
  if (container === chatArea || !container?.dataset?.stepLiveRegion) {
    container.appendChild(child);
    return;
  }

  const firstStepCard = [...container.children].find((el) => el.dataset.stepStartTime !== undefined);
  if (firstStepCard) {
    container.insertBefore(child, firstStepCard);
  } else {
    container.appendChild(child);
  }
}

function addMessage(role, content, msgIndex, container = chatArea) {
  const div = document.createElement("div");
  div.className = `message ${role}-message`;
  if (msgIndex !== undefined) div.dataset.msgIndex = String(msgIndex);

  const avatar = role === "agent" ? createAgentAvatarEl() : createUserAvatarEl();
  div.appendChild(avatar);

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  const inner = document.createElement("div");
  inner.className = "markdown-content";
  inner.innerHTML = renderMarkdown(content || "");
  bubble.appendChild(inner);
  div.appendChild(bubble);

  appendLiveTurnChild(container, div);
  scrollToBottom();
  return div;
}

function getFunctionCall(part) {
  return part?.functionCall || part?.function_call || null;
}

function getFunctionResponse(part) {
  return part?.functionResponse || part?.function_response || null;
}

function getPlotPaths(response) {
  const paths = [];
  const add = (path) => {
    if (typeof path === "string" && path && !paths.includes(path)) paths.push(path);
  };
  add(response?.plot_path);
  if (Array.isArray(response?.plot_paths)) {
    response.plot_paths.forEach(add);
  }
  return paths;
}

function getStructurePaths(payload) {
  const paths = [];
  const add = (path) => {
    if (typeof path === "string" && path && !paths.includes(path)) paths.push(path);
  };
  const visit = (value, key = "") => {
    if (!value) return;
    if (key === "structure_path") {
      add(value);
      return;
    }
    if (key === "structure_paths" && Array.isArray(value)) {
      value.forEach(add);
      return;
    }
    if ((key === "artifacts" || key === "artifact_paths") && Array.isArray(value)) {
      value.forEach((path) => {
        if (classifyPath(String(path)) === "structure") add(path);
      });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, key));
      return;
    }
    if (typeof value === "object") {
      Object.entries(value).forEach(([childKey, childValue]) => visit(childValue, childKey));
    }
  };
  visit(payload);
  return paths;
}

function createStructureViewButton(path) {
  const btn = document.createElement("button");
  btn.className = "ghost structure-view-btn";
  btn.textContent = `🔬 View: ${path.split("/").pop()}`;
  btn.addEventListener("click", () => openViewer({ path, url: pathToApiUrl(path) }));
  return btn;
}

function createArtifactListItem(path) {
  const li = document.createElement("li");
  li.title = path;
  if (classifyPath(path) === "structure") {
    li.appendChild(createStructureViewButton(path));
  } else {
    li.textContent = path.split("/").pop();
  }
  return li;
}

function isExecutorLauncherTool(name) {
  return ["run_flash_step", "run_node_executor", "run_sub_agent"].includes(name || "");
}

// Render a typed timeline array into a container element, mirroring
// Streamlit's render_stream_timeline: thoughts and tool calls go into
// collapsible <details> blocks; text parts render as markdown;
// plot_path responses render as inline images.
function renderTimeline(container, timeline, shownPlotPaths = null) {
  container.innerHTML = "";
  const containerPlotPaths = container._plotPaths || new Set();
  const visiblePlotPaths = new Set();
  for (const item of timeline) {
    if (item.type === "thought") {
      const details = document.createElement("details");
      details.className = "timeline-thought";
      const summary = document.createElement("summary");
      summary.textContent = "🤔 Thinking...";
      details.appendChild(summary);
      const body = document.createElement("div");
      body.className = "markdown-content";
      body.innerHTML = renderMarkdown(item.text || "");
      details.appendChild(body);
      container.appendChild(details);
    } else if (item.type === "function_call") {
      const details = document.createElement("details");
      details.className = "timeline-function-call";
      if (isExecutorLauncherTool(item.name)) details.open = true;
      const summary = document.createElement("summary");
      summary.innerHTML = `<span class="timeline-badge badge-in">IN</span> ${item.name}`;
      details.appendChild(summary);
      details.appendChild(createJsonBlock(JSON.stringify(item.args, null, 2)));
      container.appendChild(details);
      if (isExecutorLauncherTool(item.name)) {
        const inlineHost = document.createElement("div");
        inlineHost.className = "step-feed-inline-region";
        inlineHost.dataset.stepInlineHost = item.name;
        container.appendChild(inlineHost);
        if (Array.isArray(item.stepNodes) && item.stepNodes.length) {
          item.stepNodes.forEach((node) => stepExecutionFeed.appendStatic(node, inlineHost));
        } else if (activeSessionRequest()) {
          stepExecutionFeed.attachLiveToolHost(inlineHost);
        }
      }
    } else if (item.type === "function_response") {
      const details = document.createElement("details");
      details.className = "timeline-function-response";
      const summary = document.createElement("summary");
      summary.innerHTML = `<span class="timeline-badge badge-out">OUT</span> ${item.name}`;
      details.appendChild(summary);
      details.appendChild(createJsonBlock(JSON.stringify(item.response, null, 2)));
      container.appendChild(details);
      for (const plotPath of getPlotPaths(item.response)) {
        if (
          visiblePlotPaths.has(plotPath) ||
          (shownPlotPaths && shownPlotPaths.has(plotPath) && !containerPlotPaths.has(plotPath))
        ) {
          continue;
        }
        visiblePlotPaths.add(plotPath);
        const img = document.createElement("img");
        img.src = pathToApiUrl(plotPath);
        img.className = "timeline-image";
        img.alt = plotPath.split("/").pop();
        img.style.cursor = "zoom-in";
        img.addEventListener("click", () => lightbox.open(img.src));
        container.appendChild(img);
      }
      getStructurePaths(item.response).forEach((path) => {
        container.appendChild(createStructureViewButton(path));
      });
    } else if (item.type === "text") {
      const div = document.createElement("div");
      div.className = "markdown-content";
      div.innerHTML = renderMarkdown(item.text || "");
      container.appendChild(div);
    }
  }
  container._plotPaths = visiblePlotPaths;
  visiblePlotPaths.forEach((path) => shownPlotPaths?.add(path));
  scrollToBottom();
}

// Create an agent message div with an inner timeline container, append to
// chatArea, and return the inner container for live updates.
function addAgentTimelineMessage(timeline, shownPlotPaths = null, msgIndex, container = chatArea) {
  const outer = document.createElement("div");
  outer.className = "message agent-message";
  if (msgIndex !== undefined) outer.dataset.msgIndex = String(msgIndex);
  outer.appendChild(createAgentAvatarEl());
  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  const inner = document.createElement("div");
  inner.className = "timeline-container";
  bubble.appendChild(inner);
  outer.appendChild(bubble);
  appendLiveTurnChild(container, outer);
  renderTimeline(inner, timeline, shownPlotPaths);
  return inner;
}

function formatStepDuration(node) {
  if (!node.start_time) return "—";
  if (!node.end_time) return "running…";
  const secs = ((new Date(node.end_time) - new Date(node.start_time)) / 1000).toFixed(1);
  return `${secs}s`;
}

function stepFeedTitle(node) {
  const input = node.input || {};
  const label = node.label || input.node_id || node.id;
  const action = input.action ? ` — ${input.action}` : "";
  return `${label}${action}`;
}

function renderStepInput(input) {
  const details = document.createElement("details");
  details.className = "step-feed-nested";
  const summary = document.createElement("summary");
  summary.textContent = "Input";
  details.appendChild(summary);
  details.appendChild(createJsonBlock(JSON.stringify(input, null, 2)));
  return details;
}

function renderStepConversationEvent(evt) {
  const details = document.createElement("details");
  details.className = `timeline-${evt.type} step-feed-nested`;
  const summary = document.createElement("summary");
  const icon = evt.type === "thought" ? "💭" : evt.type === "text" ? "💬" : evt.type === "function_call" ? "🔧" : "↩";
  summary.textContent = `${icon} [${evt.author || "step_executor"}] ${evt.type || "event"}`;
  details.appendChild(summary);
  details.appendChild(createJsonBlock(evt.content));
  return details;
}

function renderStepToolCall(tc) {
  const details = document.createElement("details");
  details.className = "timeline-function-call step-feed-nested";
  const dur = tc.start_time && tc.end_time
    ? ` (${((new Date(tc.end_time) - new Date(tc.start_time)) / 1000).toFixed(1)}s)`
    : "";
  const summary = document.createElement("summary");
  summary.textContent = `🔧 ${tc.name || "tool"}${dur}`;
  details.appendChild(summary);
  if (tc.args_summary) {
    details.appendChild(createJsonBlock(tc.args_summary));
  }
  if (tc.result_summary) {
    const pre = createJsonBlock(`→ ${tc.result_summary}`);
    pre.style.borderTop = "1px solid rgba(255,255,255,0.06)";
    details.appendChild(pre);
  }
  getStructurePaths(tc).forEach((path) => {
    details.appendChild(createStructureViewButton(path));
  });
  return details;
}

function setWorkspaceCliOpen(open) {
  workspaceCli?.classList.toggle("hidden", !open);
  workspaceCliToggle?.classList.toggle("is-active", open);
  workspaceCliToggle?.setAttribute("aria-expanded", String(open));
  if (open) {
    startWorkspaceTerminal();
  } else {
    stopWorkspaceTerminal();
  }
}

function terminalWebSocketUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams();
  if (state.deploymentMode === "server" && state.userId) params.set("user_id", state.userId);
  const qs = params.toString();
  return `${protocol}//${window.location.host}/api/workspace/terminal${qs ? `?${qs}` : ""}`;
}

function resizeWorkspaceTerminal() {
  if (!workspaceTerminal || !workspaceTerminalFit || !workspaceTerminalSocket) return;
  try {
    workspaceTerminalFit.fit();
    if (workspaceTerminalSocket.readyState === WebSocket.OPEN) {
      workspaceTerminalSocket.send(JSON.stringify({
        type: "resize",
        rows: workspaceTerminal.rows,
        cols: workspaceTerminal.cols,
      }));
    }
  } catch (_) { /* terminal may not be visible yet */ }
}

function handleWorkspaceTerminalCopy(event) {
  if (!workspaceTerminal?.hasSelection?.()) return;
  const selectedText = workspaceTerminal.getSelection();
  if (!selectedText) return;
  event.preventDefault();
  event.clipboardData?.setData("text/plain", selectedText);
  navigator.clipboard?.writeText(selectedText).catch(() => {});
}

function writeWorkspaceTerminalSelectionToClipboard() {
  if (!workspaceTerminal?.hasSelection?.()) return false;
  const selectedText = workspaceTerminal.getSelection();
  if (!selectedText) return false;
  navigator.clipboard?.writeText(selectedText).catch(() => {});
  return true;
}

function handleWorkspaceTerminalKeydown(event) {
  const isCopyKey = (event.ctrlKey || event.metaKey) && event.key?.toLowerCase?.() === "c";
  if (!isCopyKey) return;
  workspaceTerminalCtrlCKeyAt = Date.now();
  if (!workspaceTerminal?.hasSelection?.()) return;
  event.preventDefault();
  event.stopPropagation();
  writeWorkspaceTerminalSelectionToClipboard();
}

function handleWorkspaceTerminalPointerDown() {
  workspaceTerminalPointerDown = true;
}

function handleWorkspaceTerminalPointerUp() {
  if (workspaceTerminalPointerDown && workspaceTerminal?.hasSelection?.()) {
    workspaceTerminalSelectionReleasedAt = Date.now();
  }
  workspaceTerminalPointerDown = false;
}

function shouldSuppressWorkspaceTerminalInput(data) {
  if (data !== "\x03") return false;
  const now = Date.now();
  const afterMouseSelection = now - workspaceTerminalSelectionReleasedAt < 500;
  const fromKeyboardShortcut = now - workspaceTerminalCtrlCKeyAt < 500;
  return afterMouseSelection && !fromKeyboardShortcut;
}

function startWorkspaceTerminal() {
  if (!workspaceTerminalEl) return;
  if (workspaceTerminalSocket && workspaceTerminalSocket.readyState === WebSocket.OPEN) {
    workspaceTerminal?.focus();
    resizeWorkspaceTerminal();
    return;
  }
  workspaceTerminalEl.innerHTML = "";
  workspaceTerminal = new Terminal({
    cursorBlink: true,
    convertEol: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: 12,
    theme: {
      background: "#030712",
      foreground: "#d1fae5",
      cursor: "#7dd3fc",
      selectionBackground: "#1e40af88",
    },
  });
  workspaceTerminalFit = new FitAddon();
  workspaceTerminal.loadAddon(workspaceTerminalFit);
  workspaceTerminal.open(workspaceTerminalEl);
  workspaceTerminalEl.removeEventListener("copy", handleWorkspaceTerminalCopy);
  workspaceTerminalEl.addEventListener("copy", handleWorkspaceTerminalCopy);
  workspaceTerminalEl.removeEventListener("keydown", handleWorkspaceTerminalKeydown, true);
  workspaceTerminalEl.addEventListener("keydown", handleWorkspaceTerminalKeydown, true);
  workspaceTerminalEl.removeEventListener("pointerdown", handleWorkspaceTerminalPointerDown);
  workspaceTerminalEl.addEventListener("pointerdown", handleWorkspaceTerminalPointerDown);
  workspaceTerminalEl.removeEventListener("pointerup", handleWorkspaceTerminalPointerUp);
  workspaceTerminalEl.addEventListener("pointerup", handleWorkspaceTerminalPointerUp);
  workspaceTerminal.write("\r\nStarting workspace terminal...\r\n");
  workspaceTerminalFit.fit();
  workspaceTerminal.focus();

  workspaceTerminalSocket = new WebSocket(terminalWebSocketUrl());
  workspaceTerminalSocket.addEventListener("open", () => {
    resizeWorkspaceTerminal();
  });
  workspaceTerminalSocket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === "output") workspaceTerminal.write(message.data || "");
    } catch (_) {
      workspaceTerminal.write(String(event.data || ""));
    }
  });
  workspaceTerminalSocket.addEventListener("close", () => {
    workspaceTerminal?.write("\r\n[terminal closed]\r\n");
  });
  workspaceTerminalSocket.addEventListener("error", () => {
    workspaceTerminal?.write("\r\n[terminal connection error]\r\n");
  });
  workspaceTerminal.onData((data) => {
    if (shouldSuppressWorkspaceTerminalInput(data)) return;
    if (workspaceTerminalSocket?.readyState === WebSocket.OPEN) {
      workspaceTerminalSocket.send(JSON.stringify({ type: "input", data }));
    }
  });
}

function stopWorkspaceTerminal() {
  if (workspaceTerminalSocket) {
    workspaceTerminalSocket.close();
    workspaceTerminalSocket = null;
  }
  workspaceTerminal?.dispose();
  workspaceTerminal = null;
  workspaceTerminalFit = null;
  workspaceTerminalEl?.removeEventListener("copy", handleWorkspaceTerminalCopy);
  workspaceTerminalEl?.removeEventListener("keydown", handleWorkspaceTerminalKeydown, true);
  workspaceTerminalEl?.removeEventListener("pointerdown", handleWorkspaceTerminalPointerDown);
  workspaceTerminalEl?.removeEventListener("pointerup", handleWorkspaceTerminalPointerUp);
  if (workspaceTerminalEl) workspaceTerminalEl.innerHTML = "";
}

workspaceCliToggle?.addEventListener("click", () => {
  setWorkspaceCliOpen(workspaceCli?.classList.contains("hidden"));
});

skillGraphOpenBtn?.addEventListener("click", () => {
  skillGraphController.open({ force: true });
});

window.addEventListener("resize", resizeWorkspaceTerminal);

async function refreshSessionFiles(sessionId = state.sessionId, owner = state.activeSessionUserId || state.userId) {
  if (!sessionId || !state.sessionReady) return;
  try {
    const resp = await fetch(`/api/sessions/${sessionId}/files`);
    if (!resp.ok) return;
    const data = await resp.json();
    if (sessionRequestKey(sessionId, owner) !== sessionRequestKey()) return;
    renderSessionFilesTree(data.files || []);
  } catch (_) {}
}

function setUploadStatus(message, tone = "idle") {
  if (!uploadStatus) return;
  uploadStatus.textContent = message || "";
  uploadStatus.className = `upload-status upload-status-${tone}`;
}

function renderCurrentUploadChips() {
  if (!uploadStatus) return;
  uploadStatus.innerHTML = "";
  uploadStatus.className = "upload-status upload-file-list";
  if (!state.currentUploads.length) return;

  state.currentUploads.forEach((file) => {
    const chip = document.createElement("span");
    chip.className = "upload-file-chip";

    const name = document.createElement("span");
    name.className = "upload-file-name";
    name.textContent = file.name;
    name.title = file.path;
    chip.appendChild(name);

    const removeBtn = document.createElement("button");
    removeBtn.className = "upload-file-remove";
    removeBtn.type = "button";
    removeBtn.title = "Delete uploaded file";
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", () => deleteUploadedFile(file));
    chip.appendChild(removeBtn);

    uploadStatus.appendChild(chip);
  });
}

function clearCurrentUploads() {
  state.currentUploads = [];
  renderCurrentUploadChips();
}

function mergeUploadedFiles(existingFiles, newFiles) {
  const merged = [...existingFiles];
  const seenPaths = new Set(existingFiles.map((file) => file?.path).filter(Boolean));

  newFiles.forEach((file) => {
    const path = file?.path;
    if (path && seenPaths.has(path)) return;
    if (path) seenPaths.add(path);
    merged.push(file);
  });

  return merged;
}

function sessionRelativeUploadPath(file) {
  const normalized = String(file?.path || "").replaceAll("\\", "/");
  const marker = `/${state.sessionId}/`;
  const markerIdx = normalized.indexOf(marker);
  if (markerIdx >= 0) return normalized.slice(markerIdx + marker.length);
  return file?.name ? `uploads/${file.name}` : normalized;
}

function messageWithUploadContext(message, uploads) {
  if (!uploads.length) return message;
  const fileLines = uploads.map((file) => {
    const relPath = sessionRelativeUploadPath(file);
    return `- ${file.name}: ${relPath} (absolute path: ${file.path})`;
  });
  return [
    message,
    "",
    "The user uploaded the following file(s) for this message. They are saved in the current session workspace. Use these paths when inspecting or processing the files:",
    ...fileLines,
  ].join("\n");
}

function formatUploadNames(uploadNames) {
  if (!uploadNames.length) return "";
  return `Attached: ${uploadNames.map((name) => `\`${name}\``).join(", ")}`;
}

function messageWithUploadNames(message, uploads) {
  const uploadNames = uploads.map((file) => file.name).filter(Boolean);
  const suffix = formatUploadNames(uploadNames);
  return suffix ? `${message}\n\n${suffix}` : message;
}

function displayMessageFromStoredUserText(message) {
  const marker = "\n\nThe user uploaded the following file(s) for this message.";
  const rawMessage = String(message || "");
  const markerIdx = rawMessage.indexOf(marker);
  if (markerIdx < 0) return rawMessage;

  const visibleMessage = rawMessage.slice(0, markerIdx);
  const hiddenContext = rawMessage.slice(markerIdx);
  const uploadNames = hiddenContext
    .split("\n")
    .map((line) => line.match(/^-\s+([^:]+):/)?.[1]?.trim())
    .filter(Boolean);
  const suffix = formatUploadNames(uploadNames);
  return suffix ? `${visibleMessage}\n\n${suffix}` : visibleMessage;
}

async function deleteUploadedFile(file) {
  if (!file?.path || !state.sessionId) return;
  try {
    const resp = await fetch(
      `/api/sessions/${encodeURIComponent(state.sessionId)}/files?path=${encodeURIComponent(file.path)}`,
      { method: "DELETE" }
    );
    if (!resp.ok) {
      const detail = await resp.text();
      throw new Error(detail || `HTTP ${resp.status}`);
    }
    state.currentUploads = state.currentUploads.filter((item) => item.path !== file.path);
    renderCurrentUploadChips();
    await refreshSessionFiles();
  } catch (err) {
    setUploadStatus(`Delete failed: ${err.message || err}`, "error");
  }
}

async function uploadFilesToSession(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  if (!state.userId) { showLoginModal(); return; }
  if (!canWriteActiveSession()) {
    addMessage("agent", `Admin view is read-only for ${state.activeSessionUserId}'s session.`);
    return;
  }

  if (!state.sessionReady) await createSession();
  if (!state.sessionReady) {
    setUploadStatus("Could not create session.", "error");
    return;
  }

  if (fileUploadBtn) fileUploadBtn.disabled = true;
  const uploaded = [];
  try {
    for (const file of files) {
      setUploadStatus(`Uploading ${file.name}...`, "busy");
      const formData = new FormData();
      formData.append("file", file);
      const resp = await fetch(`/api/sessions/${encodeURIComponent(state.sessionId)}/files`, {
        method: "POST",
        body: formData,
      });
      if (!resp.ok) {
        const detail = await resp.text();
        throw new Error(detail || `HTTP ${resp.status}`);
      }
      uploaded.push(await resp.json());
    }

    await refreshSessionFiles();
    state.currentUploads = mergeUploadedFiles(state.currentUploads, uploaded);
    renderCurrentUploadChips();
  } catch (err) {
    setUploadStatus(`Upload failed: ${err.message || err}`, "error");
  } finally {
    if (fileUploadBtn) fileUploadBtn.disabled = false;
    fileUploadInput.value = "";
  }
}

// ---------------------------------------------------------------------------
// Session summary (experimental)
// ---------------------------------------------------------------------------

function renderSessionBanner(summary) {
  if (!sessionSummaryText) return;
  const defaultTitle = sessionSummaryText.dataset.defaultTitle || "Chat";
  if (summary) {
    sessionSummaryText.textContent = summary;
    chatTab?.setAttribute("title", sessionTabTooltip(summary));
    sessionSummaryText.classList.remove("session-summary-placeholder");
    sessionSummaryText.classList.remove("typewriter", "typewriter-done");
    sessionSummaryText.style.removeProperty("opacity");
    sessionSummaryText.style.removeProperty("max-width");
  } else {
    sessionSummaryText.textContent = defaultTitle;
    chatTab?.setAttribute("title", sessionTabTooltip(defaultTitle));
    sessionSummaryText.classList.remove("session-summary-placeholder", "typewriter", "typewriter-done");
    sessionSummaryText.style.removeProperty("opacity");
    sessionSummaryText.style.removeProperty("max-width");
  }
}

function runTypewriter(el, text) {
  el.classList.remove("typewriter", "typewriter-done");
  el.style.opacity = "";
  el.style.maxWidth = "none";
  el.textContent = text;
  const fullW = el.scrollWidth;
  el.style.maxWidth = "";
  void el.offsetWidth;
  const len = [...text].length;
  el.style.setProperty("--tw-steps", len);
  el.style.setProperty("--tw-width", fullW + "px");
  el.textContent = text;
  el.classList.add("typewriter");
  el.addEventListener("animationend", function onEnd() {
    el.removeEventListener("animationend", onEnd);
    el.classList.remove("typewriter");
    el.classList.add("typewriter-done");
    el.style.removeProperty("--tw-steps");
    el.style.removeProperty("--tw-width");
  });
}

function startSummaryEdit() {
  if (!sessionSummaryText || !chatTab || chatTab.querySelector("input")) return;
  const isPlaceholder = sessionSummaryText.classList.contains("session-summary-placeholder");
  const defaultTitle = sessionSummaryText.dataset.defaultTitle || "Chat";
  const original = isPlaceholder || sessionSummaryText.textContent === defaultTitle ? "" : sessionSummaryText.textContent;
  const input = document.createElement("input");
  input.type = "text";
  input.value = original;
  input.className = "session-summary-input";
  input.maxLength = 60;
  input.placeholder = "Enter session name…";
  const labelWidth = Math.ceil(sessionSummaryText.getBoundingClientRect().width);
  input.style.width = `${Math.max(44, labelWidth)}px`;
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("dblclick", (e) => e.stopPropagation());
  sessionSummaryText.style.display = "none";
  chatTab.insertBefore(input, sessionSummaryText);
  input.focus();
  input.select();

  const finish = async (save) => {
    const newValue = input.value.trim();
    input.remove();
    sessionSummaryText.style.display = "";
    if (save && newValue !== original) {
      if (newValue) {
        state.sessionSummaries[state.sessionId] = newValue;
        state.summaryGeneratedFor.add(state.sessionId);
        renderSessionBanner(newValue);
        await saveSessionSummary(state.sessionId, newValue);
      } else {
        delete state.sessionSummaries[state.sessionId];
        state.summaryGeneratedFor.delete(state.sessionId);
        renderSessionBanner("");
        await saveSessionSummary(state.sessionId, "");
      }
      renderSessionList._lastSessions && renderSessionList(renderSessionList._lastSessions);
    } else if (!save) {
      renderSessionBanner(original || state.sessionSummaries[state.sessionId] || "");
    }
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
}

chatTab?.addEventListener("dblclick", (e) => {
  e.preventDefault();
  e.stopPropagation();
  startSummaryEdit();
});

async function saveSessionSummary(sessionId, summary) {
  try {
    const owner = state.activeSessionUserId || state.userId || "";
    const query = owner ? `?user_id=${encodeURIComponent(owner)}` : "";
    await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/summary${query}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summary }),
    });
  } catch (_) {
    // silently ignore
  }
}

async function generateSessionSummary(sessionId) {
  try {
    const owner = state.activeSessionUserId || state.userId || "";
    const query = owner ? `?user_id=${encodeURIComponent(owner)}` : "";
    const resp = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/summarize${query}`, {
      method: "POST",
    });
    if (!resp.ok) return;
    const data = await resp.json();
    if (data.summary) {
      state.sessionSummaries[sessionId] = data.summary;
      state.summaryGeneratedFor.add(sessionId);
      // Only update banner if user is still on this session
      if (sessionId === state.sessionId) {
        renderSessionBanner(data.summary);
      }
      // Refresh session list to show summary
      renderSessionList._lastSessions && renderSessionList(renderSessionList._lastSessions);
    }
  } catch (_) {
    // silently ignore — summary is non-critical
  }
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

async function createSession() {
  state.activeSessionUserId = state.userId;
  const sessionId = state.sessionId;
  const url = `/apps/${APP_NAME}/users/${activeSessionBackendUserId()}/sessions/${sessionId}`;
  const defaultWorkdir = (state.defaultWorkdir || "").trim();
  const sessionWorkdir = state.customWorkdir || defaultWorkdir;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(state.agentMode !== "normal" ? { agent_mode: state.agentMode } : {}),
        ...(state.agentMode === "bench" ? { benchmark_mode: true } : {}),
        ...(sessionWorkdir ? { custom_workdir: sessionWorkdir } : {}),
      }),
    });
    const existingResp = resp.status === 409 ? await fetch(url) : null;
    if (!resp.ok) {
      if (!existingResp?.ok) {
        if (resp.status !== 409) console.error(`Failed to create session: HTTP ${resp.status}`, await resp.text());
        return;
      }
    }
    state.sessionReady = true;
    if (resp.status !== 409) await startKnowledgeReview(sessionId);
    await loadSessions();
  } catch (err) {
    console.error("Failed to create session:", err);
  }
}

async function discoverManagedRun(sessionId, owner = state.activeSessionUserId || state.userId) {
  if (!owner || !sessionId) return null;
  try {
    const query = new URLSearchParams({ user_id: owner, session_id: sessionId });
    const resp = await fetch(`/api/runs/active?${query}`);
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.run || null;
  } catch (_) {
    return null;
  }
}

function startManagedRunReconnect(activeRun, sessionId, owner = state.activeSessionUserId || state.userId) {
  if (!activeRun?.run_id) return;
  const key = sessionRequestKey(sessionId, owner);
  if (state.activeRequests.get(key)) return;
  const request = {
    key,
    sessionId,
    owner,
    backendUserId: owner,
    controller: new AbortController(),
    lastSequence: activeRun.latest_sequence || 0,
    runId: activeRun.run_id,
  };
  state.activeRequests.set(request.key, request);
  updateSendButtonState();
  void streamManagedRunEvents(request);
}

async function streamManagedRunEvents(request) {
  try {
    const resp = await fetch(managedRunEventsUrl(request), {
      headers: { "Accept": "text/event-stream" },
      signal: request.controller.signal,
    });
    if (!resp.ok) return;
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let eventBuf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      eventBuf += decoder.decode(value, { stream: true });
      const lines = eventBuf.split("\n");
      eventBuf = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        try {
          const event = JSON.parse(trimmed.slice(6));
          if (event.type === "event") request.lastSequence = event.sequence || request.lastSequence;
          if (event.type === "snapshot_required") await loadSession(request.sessionId, request.owner);
        } catch (_) {}
      }
    }
  } catch (_) {
    // reconnect is best-effort; a normal send path will surface hard errors.
  } finally {
    releaseSessionRequest(request);
    await loadSession(request.sessionId, request.owner);
  }
}

function renderKnowledgeReviewStatus(review) {
  const status = review?.status || "idle";
  const running = status === "running";
  const progress = review?.progress || {};
  const phase = review?.phase || "memory";
  const completed = progress.completed || 0;
  const total = progress.total || 0;
  const results = Array.isArray(review?.results) ? review.results : [];
  const errors = Array.isArray(review?.errors) ? review.errors : [];
  if (knowledgeReviewBanner) {
    knowledgeReviewBanner.disabled = running;
    knowledgeReviewBanner.className = `knowledge-review-banner status-${status}`;
    const detail = review?.summary || errors[0];
    knowledgeReviewBanner.title = detail
      ? `${detail}${running ? "" : " Click to review memory and graph nodes."}`
      : running
        ? "Knowledge review is running"
        : "Click to review memory and graph nodes";
  }
  knowledgeReviewSpinner?.classList.toggle("hidden", !running);
  if (knowledgeReviewText) {
    if (running) {
      const phaseLabel = phase === "graph" ? "graph nodes" : "memory";
      knowledgeReviewText.textContent = total
        ? `Reviewing ${phaseLabel}: ${completed}/${total} (${progress.percent || 0}%)`
        : `Starting ${phaseLabel} review`;
    } else if (status === "failed") {
      knowledgeReviewText.textContent = `Review failed: ${errors[0] || "unknown error"} · click to retry`;
    } else if (status === "completed" || status === "completed_with_errors") {
      const memoryCount = results.filter((item) => item.phase === "memory").length;
      const graphCount = results.filter((item) => item.phase === "graph").length;
      const warning = errors.length ? `, ${errors.length} errors` : "";
      const summary = review?.summary?.trim();
      if (memoryCount === 0 && graphCount === 0 && summary) {
        knowledgeReviewText.textContent = `${summary}${warning} · click to run again`;
      } else {
        knowledgeReviewText.textContent = `Review complete: ${memoryCount} memory, ${graphCount} graph actions${warning} · click to run again`;
      }
    } else {
      knowledgeReviewText.textContent = "Review memory and graph · click to start";
    }
  }
  if (!running && knowledgeReviewPoll) {
    clearInterval(knowledgeReviewPoll);
    knowledgeReviewPoll = null;
  }
}

async function refreshKnowledgeReviewStatus() {
  try {
    const resp = await fetch("/api/knowledge-review/status");
    if (!resp.ok) return;
    const review = await resp.json();
    renderKnowledgeReviewStatus(review);
    if (review.status === "running" && !knowledgeReviewPoll) {
      knowledgeReviewPoll = setInterval(refreshKnowledgeReviewStatus, 2000);
    }
  } catch (_) {
    // The banner is informational; session work should continue if polling fails.
  }
}

async function startKnowledgeReview() {
  renderKnowledgeReviewStatus({
    status: "running",
    phase: "memory",
    message: "Starting Know-Do Graph review.",
  });
  try {
    const resp = await fetch("/api/knowledge-review/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: state.sessionId }),
    });
    const review = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      renderKnowledgeReviewStatus({
        status: "failed",
        errors: [review.detail || `HTTP ${resp.status}`],
      });
      return;
    }
    renderKnowledgeReviewStatus(review);
    if (!knowledgeReviewPoll) {
      knowledgeReviewPoll = setInterval(refreshKnowledgeReviewStatus, 2000);
    }
  } catch (_) {
    renderKnowledgeReviewStatus({
      status: "failed",
      errors: ["Could not reach the review service"],
    });
  }
}

knowledgeReviewBanner?.addEventListener("click", () => {
  if (!knowledgeReviewBanner.disabled) startKnowledgeReview();
});

async function patchSessionAgentMode(mode) {
  if (!state.sessionReady || !state.sessionId) return;
  const url = `/apps/${APP_NAME}/users/${encodeURIComponent(activeSessionBackendUserId())}/sessions/${encodeURIComponent(state.sessionId)}`;
  try {
    const delta = { agent_mode: mode, benchmark_mode: mode === "bench" };
    const resp = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state_delta: delta }),
    });
    if (!resp.ok) console.error(`Failed to patch agent mode: HTTP ${resp.status}`);
  } catch (err) {
    console.error("Failed to patch agent mode:", err);
  }
}

async function fetchSessionData(sessionId) {
  const owner = state.activeSessionUserId || state.userId;
  const resp = await fetch(
    `/api/users/${encodeURIComponent(owner)}/sessions/${encodeURIComponent(sessionId)}`,
    { headers: { "Content-Type": "application/json" } }
  );
  if (!resp.ok) return null;
  return resp.json();
}

async function fetchSessionStepNodes(sessionId) {
  try {
    const graphResp = await fetch(`/api/agent-graph/${encodeURIComponent(sessionId)}`);
    if (!graphResp.ok) return [];
    const graphData = await graphResp.json();
    return Object.values(graphData.nodes || {})
      .filter((node) => node.type === "step")
      .sort((a, b) => stepNodeTimestamp(a) - stepNodeTimestamp(b));
  } catch (_) {
    return [];
  }
}

function eventTimestamp(event, fallbackOrder) {
  if (event.timestamp) {
    const raw = Number(event.timestamp);
    return raw < 1e12 ? raw * 1000 : raw;
  }
  if (event.createTime) return new Date(event.createTime).getTime();
  return fallbackOrder;
}

function stepNodeTimestamp(node) {
  return node.start_time ? new Date(node.start_time).getTime() : Infinity;
}

function buildSessionTimeline(events, stepNodes) {
  const timeline = [];
  events.forEach((event, idx) => {
    timeline.push({ type: "event", data: event, ts: eventTimestamp(event, idx), order: idx });
  });
  stepNodes.forEach((node, idx) => {
    timeline.push({ type: "step", data: node, ts: stepNodeTimestamp(node), order: 1e9 + idx });
  });
  timeline.sort((a, b) => a.ts - b.ts || a.order - b.order);
  return timeline;
}

function assignStepNodesToExecutorCalls(timeline, pendingStepNodes) {
  for (const item of timeline) {
    if (item.type !== "function_call" || !isExecutorLauncherTool(item.name)) continue;
    const nextStep = pendingStepNodes.shift();
    if (nextStep) item.stepNodes = [nextStep];
  }
  return timeline;
}

function collectFunctionResponsesById(events) {
  const frById = {};
  for (const event of events) {
    for (const part of (event.content?.parts || [])) {
      const fr = getFunctionResponse(part);
      if (fr?.id) frById[fr.id] = fr;
    }
  }
  return frById;
}

function eventToTimelineParts(event, frById, pairedResponseIds = new Set()) {
  const parts = event.content?.parts || [];
  const evtTimeline = [];
  let accText = "";

  for (const part of parts) {
    if (part.thought) {
      evtTimeline.push({ type: "thought", text: part.text || "" });
    } else if (getFunctionCall(part)) {
      const fc = getFunctionCall(part);
      const matchedFr = frById[fc.id];
      evtTimeline.push({
        type: "function_call",
        id: fc.id,
        name: fc.name || "Unknown",
        args: fc.args || {},
      });
      if (matchedFr) {
        if (matchedFr.id) pairedResponseIds.add(matchedFr.id);
        evtTimeline.push({
          type: "function_response",
          id: matchedFr.id,
          name: matchedFr.name || "Unknown",
          response: matchedFr.response || {},
        });
      }
    } else if (getFunctionResponse(part)) {
      const fr = getFunctionResponse(part);
      if (fr.id && pairedResponseIds.has(fr.id)) continue;
      const alreadyMatched = evtTimeline.some(
        (item) => item.type === "function_response" && item.id === fr.id
      );
      if (!alreadyMatched) {
        evtTimeline.push({
          type: "function_response",
          id: fr.id,
          name: fr.name || "Unknown",
          response: fr.response || {},
        });
      }
    } else if (part.text && !part.thought) {
      accText += part.text;
      const last = evtTimeline[evtTimeline.length - 1];
      if (last?.type === "text") {
        last.text = accText;
      } else {
        evtTimeline.push({ type: "text", text: accText });
      }
    }
  }

  return evtTimeline;
}

function renderSessionTimeline(events, stepNodes) {
  chatArea.innerHTML = "";
  stepExecutionFeed.reset();
  stepExecutionFeed.setHierarchy(stepNodes || []);

  const sortedEvents = (events || [])
    .map((event, idx) => ({ event, ts: eventTimestamp(event, idx), order: idx }))
    .sort((a, b) => a.ts - b.ts || a.order - b.order)
    .map((item) => item.event);
  const pendingStepNodes = (stepNodes || [])
    .filter((node) => stepExecutionFeed.isRootStep(node))
    .slice()
    .sort((a, b) => stepNodeTimestamp(a) - stepNodeTimestamp(b));
  const frById = collectFunctionResponsesById(events);
  const pairedResponseIds = new Set();
  let shownPlotPaths = new Set();
  let msgIdx = 0;

  for (const event of sortedEvents) {
    const role = event.author === "user" ? "user" : "agent";
    if (role === "user") {
      const text = displayMessageFromStoredUserText(
        (event.content?.parts || []).map((part) => part.text || "").join("")
      );
      if (text) addMessage("user", text, msgIdx++);
      shownPlotPaths = new Set();
      continue;
    }

    const evtTimeline = assignStepNodesToExecutorCalls(
      eventToTimelineParts(event, frById, pairedResponseIds),
      pendingStepNodes,
    );
    if (evtTimeline.length > 0) {
      addAgentTimelineMessage(evtTimeline, shownPlotPaths, msgIdx++);
    }
  }

  pendingStepNodes.forEach((node) => stepExecutionFeed.appendStatic(node));
}

function renderSessionSnapshot(snapshot) {
  if (!snapshot) return;
  renderSessionBanner(snapshot.summary || "");
  renderSessionTimeline(snapshot.events || [], snapshot.graphNodes || []);
  renderSessionFilesTree(snapshot.files || []);
  updateSessionWorkdirDisplay(snapshot.sessionData || {});
}

function updateSessionWorkdirDisplay(sessionData) {
  const workdirDisplay = document.getElementById("session-workdir-display");
  if (!workdirDisplay) return;
  const workdir = sessionData.state?.workdir || sessionData.state?.custom_workdir || state.defaultWorkdir || "";
  workdirDisplay.textContent = workdir;
  workdirDisplay.style.display = workdir ? "" : "none";
}

// Reload full session history from the ADK server and re-render the chat,
// mirroring Streamlit's load_session() called after send_message_sse().
async function loadSession(sessionId, owner = state.activeSessionUserId || state.userId) {
  const viewKey = sessionRequestKey(sessionId, owner);
  const requestAtStart = activeSessionRequest();
  const viewIsCurrent = () => sessionRequestKey() === viewKey;
  try {
    const [sessionData, graphNodes] = await Promise.all([
      fetchSessionData(sessionId),
      fetchSessionStepNodes(sessionId),
    ]);
    if (!sessionData) {
      if (!viewIsCurrent()) return;
      state.sessionReady = false;
      return;
    }
    if (!viewIsCurrent()) return;
    state.sessionReady = true;
    if (state.deploymentMode === "local" && sessionData.userId) {
      state.activeSessionUserId = sessionData.userId;
    }
    const events = sessionData.events || [];

    // Show the session summary in the Chat tab when available.
    if (sessionData.summary) {
      state.sessionSummaries[sessionId] = sessionData.summary;
      state.summaryGeneratedFor.add(sessionId);
    }
    const sessionSummary = sessionData.summary || state.sessionSummaries[sessionId] || "";
    renderSessionBanner(sessionSummary);

    renderSessionTimeline(events, graphNodes);
    state.sessionViewCache.set(viewKey, {
      sessionData,
      events,
      graphNodes,
      files: [],
      summary: sessionSummary,
    });
    if (state.sessionViewCache.size > 10) {
      const oldestKey = state.sessionViewCache.keys().next().value;
      state.sessionViewCache.delete(oldestKey);
    }

    const hasUserMessage = events.some((event) => event?.author === "user");
    if (hasUserMessage && !sessionSummary && !state.summaryGeneratedFor.has(sessionId)) {
      generateSessionSummary(sessionId);
    }

    if (requestAtStart && requestAtStart !== activeSessionRequest()) return;
    void refreshSessionFiles(sessionId, owner);
    updateSessionWorkdirDisplay(sessionData);
  } catch (err) {
    console.error("Failed to load session:", err);
  }
}

// ---------------------------------------------------------------------------
// Streaming deduplication helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Message sending + SSE streaming
// ---------------------------------------------------------------------------

function stopCurrentMessage() {
  const request = activeSessionRequest();
  if (!request) return;
  const query = new URLSearchParams({ user_id: request.owner || state.userId });
  fetch(`/api/sessions/${state.sessionId}/cancel?${query}`, { method: "POST" }).catch(() => {});
  request.controller.abort();
  pollCancellationConfirmed(state.sessionId);
}

function pollCancellationConfirmed(sessionId, attempts = 0) {
  const MAX_ATTEMPTS = 20;  // 20 × 2s = 40s timeout
  const INTERVAL_MS = 2000;

  if (attempts >= MAX_ATTEMPTS) {
    addMessage("agent", "⚠️ Stop requested but execution may still be running in the background.");
    return;
  }

  setTimeout(async () => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/cancel`);
      const data = await res.json();
      if (!data.cancellation_requested) {
        addMessage("agent", "✓ Execution stopped.");
        return;
      }
    } catch (_) { /* ignore transient network errors */ }
    pollCancellationConfirmed(sessionId, attempts + 1);
  }, INTERVAL_MS);
}

async function sendMessage(message) {
  if (!message.trim()) return;
  if (activeSessionRequest()) return;
  if (!state.userId) { showLoginModal(); return; }
  if (!canWriteActiveSession()) {
    addMessage("agent", `Admin view is read-only for ${state.activeSessionUserId}'s session.`);
    return;
  }

  // Clear any stale cancellation flag left over from a previous stop so that
  // step executors launched in this new run don't abort immediately.
  try { await fetch(`/api/sessions/${state.sessionId}/cancel`, { method: "DELETE" }); } catch (_) {}

  const uploadsForMessage = state.currentUploads.slice();
  const userMessageEl = addMessage("user", messageWithUploadNames(message, uploadsForMessage));
  const liveStartedAt = Date.now();
  const backendMessage = messageWithUploadContext(message, uploadsForMessage);
  textInput.value = "";
  clearCurrentUploads();
  autoResizeTextInput();

  if (!state.sessionReady) await createSession();
  if (!state.sessionReady) {
    addMessage("agent", "Failed to create session — the backend may still be loading. Please try again in a moment.");
    stepExecutionFeed.finishLiveTurn();
    return;
  }
  const previousPlanGraphKey = planGraph.currentGraphKey();
  agentGraph.reset();
  planGraph.reset();
  const liveTurnContainer = stepExecutionFeed.startLiveTurn(userMessageEl, liveStartedAt);
  agentGraph.startPolling(state.sessionId);
  planGraph.startPolling(state.sessionId, {
    autoOpenOnNewGraph: true,
    autoOpenBaselineKey: previousPlanGraphKey,
  });

  const controller = new AbortController();
  const owner = state.activeSessionUserId || state.userId;
  const request = {
    key: sessionRequestKey(state.sessionId, owner),
    sessionId: state.sessionId,
    owner,
    backendUserId: activeSessionBackendUserId(),
    controller,
    lastSequence: 0,
    runId: null,
  };
  state.activeRequests.set(request.key, request);
  updateSendButtonState();
  const payload = {
    app_name: APP_NAME,
    user_id: request.backendUserId,
    session_id: request.sessionId,
    new_message: {
      role: "user",
      parts: [{ text: backendMessage }],
    },
  };

  const timeline = [];
  let timelineContainer = null;
  let accText = "";
  let summaryTriggered = false;
  const shownPlotPaths = new Set();
  let lineBuf = "";

  const handleAdkData = (dataStr) => {
    if (dataStr === "[DONE]") return;
    try {
      const evt = JSON.parse(dataStr);
      const parts = evt?.content?.parts || [];
      for (const p of parts) {
        if (p.thought) {
          upsertTimelineThought(timeline, p.text || "");
        } else if (p.functionCall) {
          const fc = p.functionCall;
          upsertTimelineEvent(timeline, {
            type: "function_call",
            id: fc.id,
            name: fc.name || "Unknown",
            args: fc.args || {},
          });
        } else if (p.functionResponse) {
          const fr = p.functionResponse;
          upsertTimelineEvent(timeline, {
            type: "function_response",
            id: fr.id,
            name: fr.name || "Unknown",
            response: fr.response || {},
          });
          if (shouldRefreshPlanGraphForTool(fr.name)) {
            planGraph.refresh(request.sessionId);
          }
        } else if (p.text) {
          accText = mergeReplayedText(accText, p.text);
          upsertTimelineText(timeline, compactRepeatedPrefixSnapshots(accText));
          if (!summaryTriggered && !state.summaryGeneratedFor.has(request.sessionId) && !state.sessionSummaries[request.sessionId]) {
            summaryTriggered = true;
            generateSessionSummary(request.sessionId, request.owner);
          }
        }

        if (timeline.length > 0 && !timelineContainer) {
          timelineContainer = addAgentTimelineMessage(timeline, shownPlotPaths, undefined, liveTurnContainer);
        } else if (timelineContainer) {
          renderTimeline(timelineContainer, timeline, shownPlotPaths);
        }
      }
    } catch (_) {
      // ignore malformed lines
    }
  };

  const handleAdkChunk = (chunkText) => {
    lineBuf += chunkText;
    const lines = lineBuf.split("\n");
    lineBuf = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      handleAdkData(trimmed.slice(6));
    }
  };

  try {
    const startResp = await fetch("/api/runs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: request.controller.signal,
    });
    if (!startResp.ok) throw new Error(`HTTP ${startResp.status}`);
    const activeRun = await startResp.json();
    request.runId = activeRun.run_id;

    const eventsResp = await fetch(managedRunEventsUrl(request), {
      headers: { "Accept": "text/event-stream" },
      signal: request.controller.signal,
    });
    if (!eventsResp.ok) throw new Error(`HTTP ${eventsResp.status}`);
    const reader = eventsResp.body.getReader();
    const decoder = new TextDecoder();
    let eventBuf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      eventBuf += decoder.decode(value, { stream: true });
      const lines = eventBuf.split("\n");
      eventBuf = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        try {
          const runEvent = JSON.parse(trimmed.slice(6));
          if (runEvent.type === "event") {
            request.lastSequence = runEvent.sequence || request.lastSequence;
            handleAdkChunk(runEvent.data || "");
          } else if (runEvent.type === "snapshot_required") {
            await loadSession(request.sessionId, request.owner);
          } else if (runEvent.type === "terminal") {
            request.lastSequence = runEvent.latest_sequence || request.lastSequence;
          }
        } catch (_) {
          // ignore malformed lines
        }
      }
    }
    // Flush remaining data in the line buffer
    if (lineBuf.trim().startsWith("data: ")) {
      const dataStr = lineBuf.trim().slice(6);
      handleAdkData(dataStr);
    }
  } catch (err) {
    if (err?.name === "AbortError") {
      addMessage("agent", "Stopping execution…", undefined, liveTurnContainer);
    } else {
      addMessage("agent", `Backend error: ${err}`, undefined, liveTurnContainer);
    }
  } finally {
    releaseSessionRequest(request);
    await agentGraph._poll(request.sessionId);
    agentGraph.stopPolling();
    await planGraph._poll(request.sessionId);
    planGraph.stopPolling();
    await refreshSessionFiles(request.sessionId, request.owner);
    stepExecutionFeed.finishLiveTurn();
    await loadSession(request.sessionId, request.owner);
  }
}

// ---------------------------------------------------------------------------
// Structure viewer
// ---------------------------------------------------------------------------

function structureTabId(path) {
  let hash = 0;
  const source = String(path || "");
  for (let i = 0; i < source.length; i++) {
    hash = ((hash << 5) - hash + source.charCodeAt(i)) | 0;
  }
  return `structure-${Math.abs(hash)}`;
}

function structureTabTitle(path) {
  const filename = String(path || "Structure").split(/[\\/]/).filter(Boolean).pop();
  return filename || "Structure";
}

function activateCenterTab(tabId) {
  state.activeCenterTabId = tabId;
  centerTabsScroll?.querySelectorAll(".center-tab")?.forEach((tab) => {
    const active = tab.dataset.tabId === tabId;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  centerTabPanels?.querySelectorAll(".center-tab-panel")?.forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.tabId === tabId);
  });

  const structureTab = structureTabs.get(tabId);
  state.structure3dViewer = structureTab?.viewer || null;
  skillGraphController.activate(tabId);
}

function closeCenterTab(tabId) {
  if (skillGraphController.close(tabId)) {
    if (state.activeCenterTabId === tabId) {
      activateCenterTab("chat");
    }
    return;
  }

  const tab = structureTabs.get(tabId);
  if (!tab) return;

  if (tab.destroyViewer) void tab.destroyViewer();
  tab.button.remove();
  tab.panel.remove();
  structureTabs.delete(tabId);

  if (state.activeCenterTabId === tabId) {
    activateCenterTab("chat");
  }
}

function ensureStructureTab(item) {
  const tabId = structureTabId(item.path);
  const existing = structureTabs.get(tabId);
  if (existing) {
    activateCenterTab(tabId);
    return existing;
  }

  const button = document.createElement("button");
  button.className = "center-tab";
  button.type = "button";
  button.role = "tab";
  button.dataset.tabId = tabId;
  button.id = `tab-${tabId}`;
  button.setAttribute("aria-selected", "false");
  button.setAttribute("aria-controls", `${tabId}-panel`);
  button.title = item.path;

  const title = document.createElement("span");
  title.className = "center-tab-title";
  title.textContent = structureTabTitle(item.path);
  button.appendChild(title);

  const close = document.createElement("span");
  close.className = "center-tab-close";
  close.dataset.closeTabId = tabId;
  close.setAttribute("aria-hidden", "true");
  close.textContent = "×";
  button.appendChild(close);

  const panel = document.createElement("div");
  panel.className = "center-tab-panel structure-tab-panel";
  panel.id = `${tabId}-panel`;
  panel.role = "tabpanel";
  panel.dataset.tabId = tabId;
  panel.setAttribute("aria-labelledby", button.id);

  const header = document.createElement("div");
  header.className = "structure-tab-header";

  const labelWrap = document.createElement("div");
  const eyebrow = document.createElement("div");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "Structure";
  const meta = document.createElement("div");
  meta.className = "sv-meta";
  labelWrap.append(eyebrow, meta);
  header.appendChild(labelWrap);

  const canvas = document.createElement("div");
  canvas.className = "sv-canvas structure-tab-canvas";

  panel.append(header, canvas);
  centerTabsScroll?.appendChild(button);
  centerTabPanels?.appendChild(panel);

  const tab = { id: tabId, item, button, panel, canvas, meta, viewer: null, destroyViewer: null };
  structureTabs.set(tabId, tab);
  activateCenterTab(tabId);
  return tab;
}

centerTabs?.addEventListener("click", (event) => {
  const closeEl = event.target.closest("[data-close-tab-id]");
  if (closeEl) {
    event.stopPropagation();
    closeCenterTab(closeEl.dataset.closeTabId);
    return;
  }

  const tab = event.target.closest(".center-tab");
  if (tab?.dataset.tabId) activateCenterTab(tab.dataset.tabId);
});

async function openViewer(item) {
  graphDetail.classList.add("hidden");
  const tab = ensureStructureTab(item);
  if (tab.viewer) return;
  if (tab.destroyViewer) await tab.destroyViewer();
  tab.viewer = null;
  tab.destroyViewer = null;
  tab.canvas.innerHTML = '<div style="color:var(--muted);padding:16px;font-size:13px">Loading…</div>';
  tab.meta.textContent = "";

  try {
    const [resp, [structureViewer, svelte]] = await Promise.all([
      fetch(`/api/structure/view?path=${encodeURIComponent(item.path)}&session_id=${encodeURIComponent(state.sessionId || "")}`),
      loadStructureViewerModules(),
    ]);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    tab.canvas.innerHTML = "";
    const structureMeta =
      `${data.formula}  ·  ${data.n_atoms} atoms${data.periodic ? "  ·  periodic" : ""}`;
    const viewer = svelte.mount(structureViewer.default, {
      target: tab.canvas,
      props: {
        structure_string: data.structure_string || data.xyz,
        source_path: item.path,
        session_id: state.sessionId || "",
        background_color: state.theme === "light" ? "#f8fbff" : "#06080f",
        performance_mode: data.n_atoms > 500 ? "speed" : "quality",
        on_modified: () => {
          tab.meta.textContent = `${structureMeta}  ·  unsaved atom edits`;
        },
        on_generated: (generated) => {
          const generatedMeta = `${generated.formula}  ·  ${generated.n_atoms} atoms`;
          tab.meta.textContent = `${generatedMeta}  ·  ${generated.operation}  ·  saved`;
          void refreshSessionFiles();
        },
      },
    });
    tab.viewer = viewer;
    tab.destroyViewer = () => svelte.unmount(viewer);
    if (state.activeCenterTabId === tab.id) state.structure3dViewer = viewer;

    tab.meta.textContent = `${structureMeta}  ·  Select an atom to edit it`;
  } catch (err) {
    tab.canvas.innerHTML =
      `<div style="color:#f87171;padding:16px;font-size:13px">Failed to load structure: ${err}</div>`;
  }
}

// ---------------------------------------------------------------------------
// File viewer
// ---------------------------------------------------------------------------

async function openFileViewer(file) {
  const modal = document.getElementById("file-viewer-modal");
  const content = document.getElementById("fv-content");
  const filenameEl = document.getElementById("fv-filename");
  if (!modal) return;

  filenameEl.textContent = file.name;
  content.innerHTML = '<p style="color:var(--muted);padding:16px 20px">Loading…</p>';
  modal.classList.remove("hidden");

  const type = classifyPath(file.path);
  const url = pathToApiUrl(file.path);

  if (type === "image") {
    const wrap = document.createElement("div");
    wrap.className = "fv-img-wrap";
    const img = document.createElement("img");
    img.src = url;
    img.alt = file.name;
    img.style.cursor = "zoom-in";
    img.addEventListener("click", () => lightbox.open(url));
    wrap.appendChild(img);
    content.innerHTML = "";
    content.appendChild(wrap);
    return;
  }

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.includes("\0")) {
      content.innerHTML = '<p style="color:var(--muted);padding:16px 20px">Binary file — cannot preview.</p>';
      return;
    }
    const pre = document.createElement("pre");
    pre.className = "fv-pre";
    pre.textContent = text;
    content.innerHTML = "";
    content.appendChild(pre);
  } catch (err) {
    content.innerHTML = `<p style="color:#f87171;padding:16px 20px">Failed to load: ${err.message}</p>`;
  }
}

document.getElementById("fv-close")?.addEventListener("click", () => {
  document.getElementById("file-viewer-modal")?.classList.add("hidden");
});
document.getElementById("file-viewer-modal")?.addEventListener("click", (e) => {
  if (e.target === e.currentTarget)
    e.currentTarget.classList.add("hidden");
});

// ---------------------------------------------------------------------------
// Image lightbox
// ---------------------------------------------------------------------------

const lightbox = createImageLightbox();

layoutController.init();

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

sendBtn.addEventListener("click", () => {
  if (activeSessionRequest()) {
    stopCurrentMessage();
    return;
  }
  sendMessage(textInput.value);
});
textInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (activeSessionRequest()) return;
    sendMessage(textInput.value);
  }
});

if (fileUploadBtn && fileUploadInput) {
  fileUploadBtn.addEventListener("click", () => fileUploadInput.click());
  fileUploadInput.addEventListener("change", (e) => uploadFilesToSession(e.target.files));
}

// Avatar upload
const avatarUploadInput = document.getElementById("avatar-upload-input");
const avatarUploadBtn = document.getElementById("avatar-upload-btn");
if (avatarUploadBtn && avatarUploadInput) {
  applyUserAvatarToEl(avatarUploadBtn);
  avatarUploadBtn.addEventListener("click", () => avatarUploadInput.click());
  avatarUploadInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setUserAvatar(ev.target.result);
      applyUserAvatarToEl(avatarUploadBtn);
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  });
}

Array.from(document.querySelectorAll("[data-quick]"))
  .forEach((btn) => btn.addEventListener("click", () => sendMessage(btn.dataset.quick || "")));

// Agent mode selector
function updateComposerModeState(mode) {
  if (!inputContainer) return;
  inputContainer.dataset.agentMode = mode || "normal";
}

if (modeSelector) {
  modeSelector.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.classList.toggle("mode-btn-active", btn.dataset.mode === state.agentMode);
  });
  updateComposerModeState(state.agentMode);
  modeSelector.addEventListener("click", (e) => {
    const btn = e.target.closest(".mode-btn");
    if (!btn) return;
    const mode = btn.dataset.mode;
    state.agentMode = mode;
    localStorage.setItem(AGENT_MODE_KEY, mode);
    modeSelector.querySelectorAll(".mode-btn").forEach((b) =>
      b.classList.toggle("mode-btn-active", b.dataset.mode === mode)
    );
    updateComposerModeState(mode);
    patchSessionAgentMode(mode);
  });
}

resetBtn.addEventListener("click", () => {
  _doNewSession(state.defaultWorkdir || "");
});

async function _doNewSession(customWorkdir) {
  state.customWorkdir = customWorkdir;
  state.sessionId = newSessionId();
  state.activeSessionUserId = state.userId;
  state.sessionReady = false;
  localStorage.setItem("mat_sessionId", state.sessionId);
  sessionIdEl.textContent = state.sessionId;
  chatArea.innerHTML = "";
  stepExecutionFeed.reset();
  state.sessionSummaries = {};
  state.summaryGeneratedFor = new Set();
  renderSessionBanner("");
  renderSessionFilesTree([]);
  clearCurrentUploads();
  agentGraph.reset();
  planGraph.reset();
  hidePlanGraph();
  await createSession();
}
