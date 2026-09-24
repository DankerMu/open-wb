## Context
Closure prerequisite already met: #107closed2026-09-24T07:39:14Z; #132merged8f6d033 master35978802687/uid107565512880 actualEACCES/UIDtest1passed0skip and fourfile38requestsmoke. ADR0010 explicitly permits removingregistration afterUIDjobgreen; deploymentexercise remains separate.
## Goals / Non-Goals
Change surface: constraints.yaml → AGENTS.md → existing source-derived guardrail oracle, atomically.
Must preserve: three other downgrades exact fields/order, ten verification surfaces, every threshold/CIstep, old actionmatrix8/6, all UID runtime/lifecycle controls and old smoke/UI behavior.
Must change: remove only active s0b_same_uid_credential_exposure registration and add enforcement row below.
| uid 隔离 | `.github/workflows/ci.yml`（job `uid-isolation`） | CI `uid-isolation`/`all-checks-passed` | block |
Governing invariant: active control-plane claims match already demonstrated master UID job; a stale downgrade or fake/missing/weakened enforcement row cannot pass the oracle.
Sibling surfaces: strictness_profile owner-scopedYAMLparser, AGENTS Markdownsection/fence parser, existingKnownblindspots, canonicalchat/CI/UIDspecs and immutablehistoricalarchives.
## Decisions
Change oracle expectations/mutation cases first; Main captures semantic RED against unchanged docs/registry. Then remove registryentry first (normativeauthority), addrow and restoreGREEN. No productioncode needed.
Decode embedded Python with shell argument parse then AST literal_eval; editdecodedcode and reencodeusingrepr + POSIXsinglequote. Main verifiesdecodedparse beforeusingmutantresults; a SyntaxErrorbaseline invalidatesnegativeproof.
Keep exact three remaining downgrade entries; update old removal/closure/chosen controls into reintroduction/duplicate-owner and UIDrowmissing/wrongjob/wronglevel/fence/commentnegativecases. Existingparsersemanticownership must remain.
Positive comment/decoy controls may pass where they do not alter activecontracts; merely samekeyword elsewhere cannot satisfy missingrow. ActiveS0bregistry reintroduction fails. Do not remove unrelatednegativecontrols tostay800lines.
## Required Evidence
Baseline make test-guardrails GREEN. New oracle with olddocs/registry RED at closureexpectation, notparse/missinganchor failure. Finalpositive andallnegativecontrols GREEN; decodedparse,anti-drift and exactheadCIgreen.
Archivedspecs: updatefullcurrentCIandchatcontrolrequirements, preservingeveryunrelatedscenario; addclosureUIDrequirement only. HistoricalS0barchivesunchanged.
Expandedfrozen3seatreview, boundedfixgate, mergeandselectivearchive. Sourcegoldenrow exactbytes includingfourcolumns; no inventedlocalmakeuidtarget.
## Risks / Trade-offs
This closes the agreed repositorydowngrade, notlinuxdeploymentvalidationorpertenantuidisolation. UnsetOMP_USER behaviorandADRunchanged.
Knownblindspots alreadyexcludesproc; avoid unnecessaryedit. No#135DirectoryMap/fourfilematrixwording inthisslice.
