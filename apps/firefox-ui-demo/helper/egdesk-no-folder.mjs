// u3 (D10): EG-Desk's own file and command tools answer { status: 'no_folder', code } when the conversation has no project folder. The engine (Claude) read that word aloud ("EG-Desk가 no_folder를
// 반환했는데…"). The refusal now also carries the person's own sentence, the first sentence of the screen's existing text for this case (overlay CHAT_REQUEST_PROJECT_CONNECT), and a closed hint like
// the page tools' grantHint, so the engine words the reason instead of the code. The status and code stay as they were (the shadow checks and the tests read them).
export const NO_FOLDER_MESSAGE = '연결된 프로젝트 폴더가 없습니다.'
export const NO_FOLDER_HINT = Object.freeze({ needs: 'project_folder' })
export const noFolderBody = code => ({ status: 'no_folder', code, message: NO_FOLDER_MESSAGE, hint: NO_FOLDER_HINT })
