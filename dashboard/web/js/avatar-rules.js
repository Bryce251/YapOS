import { AnimError, readAnimated } from './banner-anim.js';

export const AVATAR_API = '/api/me/profile-avatar';
export const AVATAR_REFRESH_API = '/api/avatars/refresh';
export const AVATAR_PREFIX = '/avatar-img/';
export const AVATAR_FILE_MAX = 5 * 1024 * 1024;
export const AVATAR_SIDE = 512;
export const AVATAR_MIN_SIDE = 64;
export const AVATAR_STILL_MAX = 600 * 1024;
export const AVATAR_FRAME_MAX = 200 * 1024;
export const AVATAR_ANIM_MAX = 5 * 1024 * 1024;
export const AVATAR_ANIM_MIN_SIDE = 32;
export const AVATAR_ANIM_MAX_SIDE = 1024;
export const AVATAR_ANIM_MAX_RATIO = 2;
export const AVATAR_ANIM_MAX_FRAMES = 600;
export const AVATAR_ANIM_MAX_PIXELS = 150_000_000;
export const AVATAR_STILL_SIDE = 256;
export const AVATAR_REFRESH_MAX = 10;
export const AVATAR_IMG_RE = /^\/avatar-img\/a-[a-z0-9]{10}-[0-9a-f]{16}(-still)?\.(png|webp|jpg|gif)$/;
export const YAPIN_AVATAR_HOSTS = Object.freeze(['files.yapper.website', 'www.yapin.gg']);

const ANIM_OPTS = Object.freeze({ maxFrames: AVATAR_ANIM_MAX_FRAMES, noun: 'profile pictures' });

export function isAvatarImagePath(value) {
  return typeof value === 'string' && AVATAR_IMG_RE.test(value);
}

export function isYapinAvatar(value) {
  if (typeof value !== 'string' || !value) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && YAPIN_AVATAR_HOSTS.includes(u.hostname) && !u.port && !u.username && !u.password;
  } catch {
    return false;
  }
}

export function checkAvatarAnim({ width, height, frames }) {
  if (width < AVATAR_ANIM_MIN_SIDE || height < AVATAR_ANIM_MIN_SIDE || width > AVATAR_ANIM_MAX_SIDE || height > AVATAR_ANIM_MAX_SIDE) {
    throw new AnimError('bad_image_size', `Moving profile pictures must be ${AVATAR_ANIM_MIN_SIDE} to ${AVATAR_ANIM_MAX_SIDE} pixels on each side.`);
  }
  if (width > height * AVATAR_ANIM_MAX_RATIO || height > width * AVATAR_ANIM_MAX_RATIO) {
    throw new AnimError('bad_image_size', 'Moving profile pictures must be close to square, at most twice as wide as they are tall or the other way round.');
  }
  if (frames < 2) throw new AnimError('not_animated', "That GIF doesn't move. Upload it as a normal picture instead.");
  if (width * height * frames > AVATAR_ANIM_MAX_PIXELS) {
    throw new AnimError('too_many_frames', 'That GIF has too many big frames to play smoothly. Make it shorter or smaller and try again.');
  }
}

export function readAvatarAnim(bytes) {
  const img = readAnimated(bytes, ANIM_OPTS);
  checkAvatarAnim(img);
  return img;
}

export function centreSquare(width, height) {
  const side = Math.max(1, Math.min(width, height));
  return { sx: Math.floor((width - side) / 2), sy: Math.floor((height - side) / 2), sw: side, sh: side };
}
