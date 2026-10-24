For S9 (screen):
- Preset choice: show `GET /profiles/tool-presets` and send POST /profiles {body, toolPreset}.
- Import: call `POST /profiles/import` with dryRun:true and show preview.adjusted, unknownFields, unmappedTools and toolCeiling. Then call it again without dryRun.
- Export: `GET /profiles/:id/export?format=` returns {filename, mediaType, text, omitted}; save it to disk. If omitted includes 'avatarImage', say "사진은 파일에 담기지 않았습니다".
- Photos: downscale and re-encode with a canvas, send to `POST /profiles/avatar-images`, then save avatar {kind:'image', value: 1–2 letter fallback, color, assetId}.
- EGDeskChatState.publicProfileAvatar currently turns an image avatar into null (falls back to the name's first letter). profileFormFromBody drops the image avatar, so editing and saving would remove the photo. S9 has to handle that.

For 2-RT:
- In egdesk-portable-service.mjs exportProfiles, use `withoutAvatarImage(record.body)` (exported from egdesk-profile-store.mjs) so bundles don't carry photo ids.
- Bundle imports already strip photos to the letter avatar.

For Main (when D-A1 is decided):
- Pass defaultToolPreset to openProfileStore in codex-bridge-server.mjs (currently line 145).

For WM:
- Add the new files to the file map: helper/egdesk-profile-file.mjs and its test.

Error codes:
- AGENT_FILE_INVALID / AGENT_FILE_FORMAT / AGENT_FILE_TOO_LONG: 400
- AGENT_FILE_TOO_LARGE: 413
- INVALID_PROFILE_IMAGE: 400
- PROFILE_IMAGE_TOO_LARGE: 413
- PROFILE_ASSET_NOT_FOUND: 400 when saving a body, 404 on GET
- PROFILE_ASSET_LIMIT: 409