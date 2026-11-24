/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Bot Player Scripts v4

// Bot Player Scripts v2

// The version of the bot player scripts installed in this world, carried in
// this file's NAME rather than only in its body. Nothing that inspects a world
// from outside the editor can read a script's contents -- the asset surface
// returns metadata, not bytes -- so the filename is the only readable place to
// put it. Renaming this file is how an upgrade records itself, and exactly one
// BotPlayerScriptsV*.ts must exist in this folder: two of them, or none, leave
// the version unreadable.
export const BOT_PLAYER_SCRIPTS_VERSION = 2;
