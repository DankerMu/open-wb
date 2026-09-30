# session-delete-idle

DELETE /api/sessions/:id for non-running sessions: control claim, deletion tombstone, retire, one transaction with the session.delete audit, then unlink; running sessions get a transitional 409 (#525)
