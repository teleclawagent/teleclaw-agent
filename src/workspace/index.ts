export {
  TELECLAW_ROOT,
  WORKSPACE_ROOT,
  WORKSPACE_PATHS,
  ALLOWED_EXTENSIONS,
  MAX_FILE_SIZES,
} from "./paths.js";

export {
  WorkspaceSecurityError,
  validatePath,
  validateReadPath,
  validateWritePath,
  validateDirectory,
  isWithinWorkspace,
  sanitizeFilename,
  validateFileSize,
  listWorkspaceDirectory,
  type ValidatedPath,
} from "./validator.js";

export {
  ensureWorkspace,
  isNewWorkspace,
  loadTemplate,
  writeFileIfMissing,
  getWorkspaceStats,
  type Workspace,
  type WorkspaceConfig,
} from "./manager.js";
