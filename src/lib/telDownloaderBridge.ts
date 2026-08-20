/**
 * telDownloaderBridge — exposes tweb's message APIs to the NAS batch downloader
 * (src/lib/telMediaDownloader.js).
 *
 * The downloader runs as a standalone script and cannot reach tweb's managers;
 * this module (bundled with the app) mounts a small, controlled API on
 * `window.__TEL_DOWNLOADER_BRIDGE__`:
 *
 *   listDialogs()                -> [{peerId, title, type}]
 *   searchMedia(peerId, filter, limit, offsetId)
 *                                -> {items: [{peerId, mid, kind, mime, size,
 *                                             fileName, url}], count}
 *
 * Media URLs are produced with tweb's own download path helpers
 * (getDocumentURL / getFileURL), so the same authenticated, Range-capable
 * stream endpoints the app uses are reused — including restricted channels
 * where the UI hides the download buttons.
 */

import rootScope from '@lib/rootScope';
import getDocumentURL from '@appManagers/utils/docs/getDocumentURL';
import choosePhotoSize from '@appManagers/utils/photos/choosePhotoSize';
import getPhotoDownloadOptions from '@appManagers/utils/photos/getPhotoDownloadOptions';
import {getFileURL} from '@helpers/fileName';
import getDialogIndex from '@appManagers/utils/dialogs/getDialogIndex';
import getDialogIndexKey from '@appManagers/utils/dialogs/getDialogIndexKey';
import {FOLDER_ID_ALL} from '@appManagers/constants';

export type BatchDialog = {
  peerId: PeerId;
  title: string;
  type: 'channel' | 'chat' | 'user';
};

export type BatchMediaItem = {
  peerId: PeerId;
  mid: number;
  kind: 'photo' | 'video' | 'gif' | 'audio' | 'document';
  mime?: string;
  size?: number;
  fileName: string;
  url: string;
};

const FILTERS: {[k: string]: any} = {
  video: {_: 'inputMessagesFilterVideo'},
  photo: {_: 'inputMessagesFilterPhotos'},
  gif: {_: 'inputMessagesFilterGif'},
  audio: {_: 'inputMessagesFilterMusic'},
  document: {_: 'inputMessagesFilterDocument'}
};

async function listDialogs(): Promise<BatchDialog[]> {
  const managers = rootScope.managers;
  // fetch ALL dialogs (paginated), not just the first page. getDialogs'
  // `offsetIndex` is a dialog SORT INDEX (a large date-based value), NOT a
  // page offset — the cursor for the next page is the previous page's last
  // dialog index. Passing a count (0, 200, 400…) makes the storage scan past
  // the end and return an empty page, silently truncating the list to the
  // first ~200 dialogs.
  const indexKey = getDialogIndexKey(FOLDER_ID_ALL);
  const seen = new Set<number>();
  const dialogs: any[] = [];
  let offsetIndex = 0;
  const LIMIT = 200;
  for(;;) {
    const page = await managers.dialogsStorage.getDialogs({limit: LIMIT, offsetIndex});
    const pageDialogs: any[] = page.dialogs || [];
    if(!pageDialogs.length) break;

    let advanced = false;
    for(const d of pageDialogs) {
      if(seen.has(d.peerId)) continue;
      seen.add(d.peerId);
      dialogs.push(d);
      advanced = true;
    }
    if(page.isEnd || !advanced) break;

    const last = pageDialogs[pageDialogs.length - 1];
    const lastIndex = getDialogIndex(last, indexKey);
    // no cursor / no progress ⇒ already at the tail (or order changed) — stop
    if(!lastIndex || (offsetIndex && lastIndex >= offsetIndex)) break;
    offsetIndex = lastIndex;
  }

  const out: BatchDialog[] = [];

  for(const d of dialogs) {
    const peerId = d.peerId;
    if(peerId === rootScope.myId) continue; // skip Saved Messages

    let title = '';
    let type: BatchDialog['type'] = 'user';

    if(peerId.isAnyChat()) {
      const chat = await managers.appChatsManager.getChat(peerId.toChatId());
      if(!chat) continue;
      title = chat.title || '';
      type = chat._ === 'channel' ? 'channel' : 'chat';
    } else {
      const user = await managers.appUsersManager.getUser(peerId.toUserId());
      if(!user) continue;
      title = (user.first_name || '') + (user.last_name ? ' ' + user.last_name : '');
    }

    if(!title) continue;
    out.push({peerId, title, type});
  }

  return out;
}

async function searchMedia(
  peerId: PeerId,
  filter: string,
  limit = 50,
  offsetId = 0
): Promise<{items: BatchMediaItem[], count: number}> {
  const managers = rootScope.managers;
  const inputFilter = FILTERS[filter] || {_: 'inputMessagesFilterEmpty'};

  const res = await managers.appMessagesManager.requestHistory({
    peerId,
    limit,
    offsetId,
    inputFilter
  } as any);

  const messages: any[] = (res as any).messages || [];
  const count = (res as any).count || messages.length;
  const items: BatchMediaItem[] = [];

  for(const msg of messages) {
    const media = msg && msg.media;
    if(!media) continue;

    const base: BatchMediaItem = {
      peerId,
      mid: msg.id,
      kind: 'document',
      fileName: '',
      url: ''
    };

    try {
      if(media._ === 'photo') {
        const size = choosePhotoSize(media, 0, 0);
        if(!size || size._ === 'photoSizeEmpty') continue;
        base.kind = 'photo';
        base.fileName = 'photo_' + msg.id + '.jpg';
        base.url = getFileURL('photo', getPhotoDownloadOptions(media, size));
      } else if(media._ === 'document') {
        const doc = media;
        base.fileName = doc.file_name || ('file_' + msg.id + (doc.mime_type ? '.' + doc.mime_type.split('/')[1] : ''));
        base.mime = doc.mime_type;
        base.size = doc.size;
        base.kind = doc.mime_type === 'image/gif' ? 'gif'
          : (doc.mime_type || '').startsWith('video/') ? 'video'
          : (doc.mime_type || '').startsWith('audio/') ? 'audio'
          : 'document';
        base.url = getDocumentURL(doc, {download: true});
      } else {
        continue;
      }
    } catch(err) {
      continue; // skip media we cannot build a URL for
    }

    if(base.url) items.push(base);
  }

  return {items, count};
}

export function mountTelDownloaderBridge() {
  (window as any).__TEL_DOWNLOADER_BRIDGE__ = {
    listDialogs,
    searchMedia
  };
}
