export {
  runGroundingGate,
  DEFAULT_SEVERITY,
  type CheckName,
  type CheckReport,
  type GroundingGateInput,
  type GroundingGateOptions,
  type GroundingGateResult,
  type GroundingViolation,
  type Severity,
} from './gate.js';

export {
  checkIdentifiers,
  extractIdentifierTokens,
  trimUrlToken,
  DEFAULT_ALLOWED_HOSTS,
  type ExtractOptions,
  type IdentifierCheckInput,
  type IdentifierCheckResult,
  type IdentifierKind,
  type UnbackedIdentifier,
} from './identifiers.js';

export {
  checkCitations,
  checkCitationCounts,
  DEFAULT_CITATION_MARKER,
  type CitationCheckResult,
  type CitationCountCheckResult,
  type CitationOptions,
  type UnsupportedCitation,
  type UnsupportedCitationCount,
} from './citations.js';

export {
  checkContradictions,
  extractFactPairs,
  findContradictions,
  type Contradiction,
  type ContradictionCheckResult,
  type FactPair,
  type IntroducedContradiction,
} from './contradictions.js';

export {
  checkQuantities,
  collectEvidenceCounts,
  extractQuantityClaims,
  type QuantityCheckResult,
  type QuantityClaim,
} from './quantities.js';

export {
  checkWrites,
  type UngroundedWriteValue,
  type WriteCall,
  type WriteCheckResult,
  type WrittenTokenKind,
} from './writes.js';

export { stripEchoedIdentifiers, ECHO_MASK } from './echoes.js';

export {
  appearsInEvidence,
  buildEvidenceText,
  type CitationIndex,
  type CitationSource,
} from './evidence.js';

export {
  checkToolArguments,
  identifierArguments,
  argumentKind,
  valueInEvidence,
  ungroundedArgumentMessage,
  type ArgumentCheckOptions,
  type ArgumentCheckResult,
  type ArgumentKind,
  type ToolCall,
  type UngroundedArgument,
} from './arguments.js';

export {
  checkAmbiguousTarget,
  ambiguousTargetMessage,
  type AmbiguityCheckOptions,
  type AmbiguityCheckResult,
  type AmbiguousTarget,
} from './ambiguity.js';

export {
  checkRepeatedCall,
  canonicalArgs,
  type PastCall,
  type RepeatCheckOptions,
  type RepeatCheckResult,
} from './repeats.js';

export {
  argumentEvidence,
  type EvidenceOptions,
  type SystemEvidence,
  type TranscriptTurn,
} from './transcript.js';

export {
  checkFigures,
  collectEvidenceFigures,
  extractFigureClaims,
  summariseFigureEvidence,
  type FigureCheckInput,
  type FigureCheckResult,
  type FigureKind,
  type UnsupportedFigure,
} from './figures.js';
export { collectRecordFacts, type RecordFacts } from './records.js';
