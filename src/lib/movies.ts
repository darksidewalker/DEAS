import { invoke } from '@tauri-apps/api/core';
import { parseManifest, serializeManifest, type MovieManifest } from './movieManifest';

export interface MovieListEntry { id: string; title: string; items: number; targetSeconds: number; updated: number }
export interface MovieList { movies: MovieListEntry[]; damaged: number }
export const newMovieId = () => `movie-${crypto.randomUUID().slice(0, 8)}`;
/** Saved movies in the app-data movies folder; damaged files are only counted. */
export const listMovies = () => invoke<MovieList>('native_movie_list');
/** Reopens a movie as stored. Nothing is submitted or resumed: a reopened movie is inert. */
export const openMovie = async (id: string): Promise<MovieManifest> => parseManifest(await invoke<string>('native_movie_open', { id }));
export interface MissingFile { id: string; kind: 'result' | 'reference'; path: string }
export interface MovieCheck { missing: MissingFile[]; checked: number; truncated: boolean }
/** Which recorded clips and reference pictures of a saved movie are no longer on disk (metadata only; paths come from the stored file). */
export const checkMovie = (id: string) => invoke<MovieCheck>('native_movie_check', { id });
export const saveMovie = (m: MovieManifest) => invoke<string>('native_movie_save', { manifest: serializeManifest(m) });
