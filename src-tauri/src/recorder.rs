//! Native lecture-recording backend.
//!
//! On iOS the webview CANNOT capture the microphone: Tauri serves the app from a
//! custom URL scheme, which WKWebView does not treat as a secure context, so
//! `navigator.mediaDevices` never exists — no amount of Info.plist permissions
//! fixes that. Capture therefore runs natively through AVAudioRecorder behind
//! these commands (AAC/.m4a straight to a temp file, level metering for the UI
//! waveform). Combined with `UIBackgroundModes: audio` (stamped into the iOS
//! Info.plist by CI) and the PlayAndRecord audio session, recording keeps
//! running while the app is backgrounded or the phone is locked.
//!
//! On macOS the web engine remains the default microphone-only path. When the
//! user explicitly enables system audio, ScreenCaptureKit records the default
//! microphone and system output into one audio-only WAV file.

use crate::error::{Error, Result};
use tauri::AppHandle;

/// Result of a stopped native recording: where the audio landed + its length.
#[derive(serde::Serialize)]
pub struct NativeRecording {
    pub path: String,
    pub secs: f64,
    pub ext: String,
}

/// One metering sample while a native recording runs.
#[derive(serde::Serialize)]
pub struct NativeMeter {
    /// Input level 0..1 for the waveform.
    pub level: f32,
    /// Elapsed recording time in seconds (authoritative — survives lock).
    pub secs: f64,
}

#[derive(serde::Serialize)]
pub struct NativeChunk {
    pub audio: Vec<u8>,
    pub cursor: u64,
}

/// Directory native recordings are written to (inside the app sandbox's tmp).
fn rec_dir() -> std::path::PathBuf {
    std::env::temp_dir().join("cortex-native-rec")
}

/// Guard: only paths produced by the native recorder may be consumed/deleted by
/// the path-based commands, so the webview can't point them at arbitrary files.
fn assert_native_rec_path(path: &str) -> Result<std::path::PathBuf> {
    let p = std::path::Path::new(path);
    let dir = rec_dir()
        .canonicalize()
        .map_err(|e| Error::Other(format!("recorder dir missing: {e}")))?;
    let canon = p
        .canonicalize()
        .map_err(|e| Error::Other(format!("recording not found at {path}: {e}")))?;
    if !canon.starts_with(&dir) {
        return Err(Error::Other("not a native recording file".into()));
    }
    Ok(canon)
}

/// Save a lecture recording that already lives in a backend file (the native
/// iOS capture path — audio never crosses the JS bridge). Reads the file, runs
/// the exact same persist→transcribe→chunk→embed pipeline as `save_recording`,
/// then removes the temp file.
#[tauri::command]
pub async fn save_recording_path(
    app: AppHandle,
    subject_id: String,
    topic_id: Option<String>,
    name: String,
    path: String,
    diarize: Option<bool>,
    live_transcript: Option<String>,
) -> Result<crate::models::IngestResult> {
    let canon = assert_native_rec_path(&path)?;
    let audio = std::fs::read(&canon)?;
    let ext = canon
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_string());
    let res = crate::commands::save_recording(
        app,
        subject_id,
        topic_id,
        name,
        audio,
        ext,
        diarize,
        live_transcript,
    )
    .await;
    if res.is_ok() {
        let _ = std::fs::remove_file(&canon);
    }
    res
}

/// Delete a stopped-but-unsaved native recording (the user discarded the take).
#[tauri::command]
pub fn native_rec_discard(path: String) -> Result<()> {
    let canon = assert_native_rec_path(&path)?;
    std::fs::remove_file(&canon)?;
    Ok(())
}

// ─────────────────────────── iOS implementation ───────────────────────────
#[cfg(target_os = "ios")]
mod ios {
    use super::*;
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::runtime::Bool;
    use objc2::AnyThread;
    use objc2_avf_audio::{
        AVAudioRecorder, AVAudioSession, AVAudioSessionCategoryOptions,
        AVAudioSessionCategoryPlayAndRecord, AVEncoderBitRateKey, AVFormatIDKey,
        AVNumberOfChannelsKey, AVSampleRateKey,
    };
    use objc2_foundation::{NSDictionary, NSNumber, NSString, NSURL};
    use std::sync::mpsc;
    use std::sync::Mutex;

    /// kAudioFormatMPEG4AAC — fourcc 'aac ' (CoreAudioTypes).
    const K_AUDIO_FORMAT_MPEG4_AAC: u32 = 0x6161_6320;

    /// The one active recorder. AVAudioRecorder is safe to drive from any thread
    /// (its API is thread-agnostic); the Retained pointer just isn't marked Send,
    /// hence the wrapper. All access goes through the mutex.
    struct Handle {
        rec: Retained<AVAudioRecorder>,
        path: std::path::PathBuf,
    }
    unsafe impl Send for Handle {}
    static ACTIVE: Mutex<Option<Handle>> = Mutex::new(None);

    /// Ask for (or confirm) mic permission. Blocks the command thread until the
    /// user answers the system prompt — first call shows the iOS mic dialog.
    fn ensure_permission(session: &AVAudioSession) -> Result<()> {
        let (tx, rx) = mpsc::channel::<bool>();
        let block = RcBlock::new(move |granted: Bool| {
            let _ = tx.send(granted.as_bool());
        });
        unsafe { session.requestRecordPermission(&block) };
        match rx.recv_timeout(std::time::Duration::from_secs(120)) {
            Ok(true) => Ok(()),
            Ok(false) => Err(Error::Other(
                "Microphone access is denied. Enable it in Settings → Cortex → Microphone, then try again.".into(),
            )),
            Err(_) => Err(Error::Other("Timed out waiting for microphone permission.".into())),
        }
    }

    pub fn start() -> Result<()> {
        // Cheap early check WITHOUT holding the lock across the permission wait —
        // ensure_permission can block for minutes on the system dialog, and any
        // concurrent native_rec_* call must not hang on the mutex meanwhile.
        if ACTIVE.lock().unwrap().is_some() {
            return Err(Error::Other("A recording is already running.".into()));
        }
        unsafe {
            let session = AVAudioSession::sharedInstance();
            ensure_permission(&session)?;
            // PlayAndRecord (+ MixWithOthers) so recording coexists with any app
            // audio and — with UIBackgroundModes:audio — survives lock/background.
            session
                .setCategory_withOptions_error(
                    // The AVFoundation constants are `Option` in objc2 only
                    // because their headers lack nullability annotations —
                    // they're linked symbols, always present at runtime.
                    AVAudioSessionCategoryPlayAndRecord
                        .expect("AVAudioSessionCategoryPlayAndRecord"),
                    AVAudioSessionCategoryOptions::MixWithOthers
                        | AVAudioSessionCategoryOptions::AllowBluetoothHFP,
                )
                .map_err(|e| Error::Other(format!("audio session category: {e}")))?;
            session
                .setActive_error(true)
                .map_err(|e| Error::Other(format!("audio session activate: {e}")))?;

            let dir = rec_dir();
            std::fs::create_dir_all(&dir)?;
            let path = dir.join(format!("rec-{}.m4a", crate::db::new_id()));
            let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));

            // AAC mono @44.1kHz / 64kbps — ~12 MB per 25-min lecture, decodes
            // everywhere (ffmpeg, PyAV, speaches).
            let keys: [&NSString; 4] = [
                AVFormatIDKey.expect("AVFormatIDKey"),
                AVSampleRateKey.expect("AVSampleRateKey"),
                AVNumberOfChannelsKey.expect("AVNumberOfChannelsKey"),
                AVEncoderBitRateKey.expect("AVEncoderBitRateKey"),
            ];
            let format = NSNumber::new_u32(K_AUDIO_FORMAT_MPEG4_AAC);
            let rate = NSNumber::new_f64(44_100.0);
            let channels = NSNumber::new_u32(1);
            let bitrate = NSNumber::new_u32(64_000);
            let values: [&AnyObject; 4] = [
                format.as_ref(),
                rate.as_ref(),
                channels.as_ref(),
                bitrate.as_ref(),
            ];
            let settings: Retained<NSDictionary<NSString, AnyObject>> =
                NSDictionary::from_slices(&keys, &values);

            let rec = AVAudioRecorder::initWithURL_settings_error(
                AVAudioRecorder::alloc(),
                &url,
                &settings,
            )
            .map_err(|e| Error::Other(format!("couldn't create the recorder: {e}")))?;
            rec.setMeteringEnabled(true);
            if !rec.record() {
                return Err(Error::Other(
                    "The recorder failed to start — is another app holding the microphone?".into(),
                ));
            }
            // Re-take the lock only for the insert; re-check in case a racing
            // start() won while we waited on the permission dialog.
            let mut active = ACTIVE.lock().unwrap();
            if active.is_some() {
                rec.stop();
                let _ = rec.deleteRecording();
                return Err(Error::Other("A recording is already running.".into()));
            }
            *active = Some(Handle { rec, path });
        }
        Ok(())
    }

    pub fn pause() -> Result<()> {
        let active = ACTIVE.lock().unwrap();
        let h = active
            .as_ref()
            .ok_or_else(|| Error::Other("no active recording".into()))?;
        unsafe { h.rec.pause() };
        Ok(())
    }

    pub fn resume() -> Result<()> {
        let active = ACTIVE.lock().unwrap();
        let h = active
            .as_ref()
            .ok_or_else(|| Error::Other("no active recording".into()))?;
        unsafe {
            if !h.rec.record() {
                return Err(Error::Other("couldn't resume the recording".into()));
            }
        }
        Ok(())
    }

    pub fn stop() -> Result<NativeRecording> {
        let mut active = ACTIVE.lock().unwrap();
        let h = active
            .take()
            .ok_or_else(|| Error::Other("no active recording".into()))?;
        let secs = unsafe {
            let secs = h.rec.currentTime(); // must be read BEFORE stop() finalizes
            h.rec.stop();
            let _ = AVAudioSession::sharedInstance().setActive_error(false);
            secs
        };
        if !h.path.is_file() {
            return Err(Error::Other("the recording file was not written".into()));
        }
        Ok(NativeRecording {
            path: h.path.to_string_lossy().into_owned(),
            secs,
            ext: "m4a".into(),
        })
    }

    pub fn cancel() -> Result<()> {
        let mut active = ACTIVE.lock().unwrap();
        if let Some(h) = active.take() {
            unsafe {
                h.rec.stop();
                let _ = h.rec.deleteRecording();
                let _ = AVAudioSession::sharedInstance().setActive_error(false);
            }
            let _ = std::fs::remove_file(&h.path);
        }
        Ok(())
    }

    pub fn meter() -> Result<super::NativeMeter> {
        let active = ACTIVE.lock().unwrap();
        let h = active
            .as_ref()
            .ok_or_else(|| Error::Other("no active recording".into()))?;
        let (db, secs) = unsafe {
            h.rec.updateMeters();
            (h.rec.averagePowerForChannel(0), h.rec.currentTime())
        };
        Ok(super::NativeMeter {
            // dBFS (-160..0) → linear 0..1.
            level: 10f32.powf(db / 20.0).clamp(0.0, 1.0),
            // Authoritative elapsed time: webview JS timers freeze while the phone
            // is locked, so the UI clock resyncs from here.
            secs,
        })
    }
}

// ────────────────────────── macOS implementation ──────────────────────────
// ScreenCaptureKit can deliver system audio and microphone samples separately.
// We write each source as 16 kHz mono PCM while recording, then align their
// first timestamps and mix them into an audio-only WAV when the user stops.
// This avoids storing screen pixels and does not require a virtual audio driver.
#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use screencapturekit::cm::{CMSampleBufferExt, CMTime};
    use screencapturekit::prelude::*;
    use std::fs::File;
    use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::{Arc, Mutex};

    const SAMPLE_RATE: u64 = 16_000;

    #[derive(Default)]
    struct PcmResampler {
        input_rate: u32,
        pending: Vec<f32>,
        position: f64,
    }

    impl PcmResampler {
        fn push(
            &mut self,
            input: &[f32],
            input_rate: u32,
        ) -> std::result::Result<Vec<f32>, String> {
            if !(8_000..=192_000).contains(&input_rate) {
                return Err(format!("unsupported capture sample rate: {input_rate} Hz"));
            }
            if self.input_rate == 0 {
                self.input_rate = input_rate;
            } else if self.input_rate != input_rate {
                return Err(format!(
                    "capture sample rate changed from {} Hz to {input_rate} Hz",
                    self.input_rate
                ));
            }
            if input_rate as u64 == SAMPLE_RATE {
                return Ok(input.to_vec());
            }

            self.pending.extend_from_slice(input);
            let step = input_rate as f64 / SAMPLE_RATE as f64;
            let mut output = Vec::with_capacity(
                ((self.pending.len() as f64 - self.position).max(0.0) / step).ceil() as usize,
            );
            while self.position + 1.0 < self.pending.len() as f64 {
                let left = self.position.floor() as usize;
                let fraction = (self.position - left as f64) as f32;
                output.push(
                    self.pending[left] * (1.0 - fraction) + self.pending[left + 1] * fraction,
                );
                self.position += step;
            }
            if self.pending.len() > 1 {
                let consumed = (self.position.floor() as usize).min(self.pending.len() - 1);
                self.pending.drain(..consumed);
                self.position -= consumed as f64;
            }
            Ok(output)
        }
    }

    #[derive(Default)]
    struct SourceState {
        file: Option<File>,
        first_pts: Option<f64>,
        samples: u64,
        resampler: PcmResampler,
    }

    struct CaptureState {
        system: SourceState,
        microphone: SourceState,
        error: Option<String>,
    }

    #[derive(Clone, Copy)]
    enum Source {
        System,
        Microphone,
    }

    struct Handle {
        stream: SCStream,
        state: Arc<Mutex<CaptureState>>,
        paused: Arc<AtomicBool>,
        level: Arc<AtomicU32>,
        system_path: std::path::PathBuf,
        microphone_path: std::path::PathBuf,
        output_path: std::path::PathBuf,
    }

    struct PendingFiles {
        system_path: std::path::PathBuf,
        microphone_path: std::path::PathBuf,
        output_path: std::path::PathBuf,
        committed: bool,
    }

    impl Drop for PendingFiles {
        fn drop(&mut self) {
            if !self.committed {
                let _ = std::fs::remove_file(&self.system_path);
                let _ = std::fs::remove_file(&self.microphone_path);
                let _ = std::fs::remove_file(&self.output_path);
            }
        }
    }

    static ACTIVE: Mutex<Option<Handle>> = Mutex::new(None);

    fn pts_seconds(time: CMTime) -> Option<f64> {
        (time.timescale > 0).then_some(time.value as f64 / time.timescale as f64)
    }

    fn decode_sample(
        sample: &screencapturekit::cm::CMSampleBuffer,
    ) -> std::result::Result<(Vec<f32>, u32), String> {
        let format = sample
            .format_description()
            .ok_or_else(|| "captured audio has no format description".to_string())?;
        let rate = format
            .audio_sample_rate()
            .ok_or_else(|| "captured audio has no sample rate".to_string())?;
        let rounded_rate = rate.round();
        if (rate - rounded_rate).abs() > 0.01 || rounded_rate > u32::MAX as f64 {
            return Err(format!("unsupported capture sample rate: {rate} Hz"));
        }
        let bits = format.audio_bits_per_channel().unwrap_or_default();
        if !format.is_pcm() || !format.audio_is_float() || bits != 32 {
            return Err(format!(
                "unsupported capture format: {}, {bits}-bit, flags {:?}",
                format.media_subtype_string(),
                format.audio_format_flags()
            ));
        }
        let buffers = sample
            .audio_buffer_list()
            .ok_or_else(|| "captured audio has no PCM buffers".to_string())?;
        if buffers.num_buffers() == 0 {
            return Ok((Vec::new(), rounded_rate as u32));
        }

        // A buffer may contain one planar channel or several interleaved
        // channels. Average every channel into the mono stream consumed by the
        // recorder and live-caption protocol.
        let mut decoded = Vec::with_capacity(buffers.num_buffers());
        for buffer in &buffers {
            let channels = buffer.number_channels.max(1) as usize;
            let bytes = buffer.data();
            let frames = bytes.len() / (4 * channels);
            let mut mono = Vec::with_capacity(frames);
            for frame in bytes.chunks_exact(4 * channels) {
                let mut sum = 0.0_f32;
                for raw in frame.chunks_exact(4) {
                    let value = if format.audio_is_big_endian() {
                        f32::from_be_bytes([raw[0], raw[1], raw[2], raw[3]])
                    } else {
                        f32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]])
                    };
                    if value.is_finite() {
                        sum += value.clamp(-1.0, 1.0);
                    }
                }
                mono.push(sum / channels as f32);
            }
            decoded.push(mono);
        }
        let frames = decoded.iter().map(Vec::len).min().unwrap_or(0);
        let mut mono = Vec::with_capacity(frames);
        for frame in 0..frames {
            mono.push(
                decoded.iter().map(|buffer| buffer[frame]).sum::<f32>() / decoded.len() as f32,
            );
        }
        Ok((mono, rounded_rate as u32))
    }

    fn write_sample(
        state: &Arc<Mutex<CaptureState>>,
        paused: &Arc<AtomicBool>,
        level: &Arc<AtomicU32>,
        source: Source,
        sample: screencapturekit::cm::CMSampleBuffer,
    ) {
        if paused.load(Ordering::Relaxed) {
            return;
        }
        let mut capture = match state.lock() {
            Ok(value) => value,
            Err(poisoned) => poisoned.into_inner(),
        };
        let target = match source {
            Source::System => &mut capture.system,
            Source::Microphone => &mut capture.microphone,
        };
        let (decoded, input_rate) = match decode_sample(&sample) {
            Ok(value) => value,
            Err(error) => {
                capture.error = Some(error);
                return;
            }
        };
        let samples = match target.resampler.push(&decoded, input_rate) {
            Ok(value) => value,
            Err(error) => {
                capture.error = Some(error);
                return;
            }
        };
        if samples.is_empty() {
            return;
        }
        let mut pcm = Vec::with_capacity(samples.len() * 2);
        let mut peak = 0.0_f32;
        for value in samples {
            peak = peak.max(value.abs());
            pcm.extend_from_slice(&((value * i16::MAX as f32).round() as i16).to_le_bytes());
        }
        level.store(peak.to_bits(), Ordering::Relaxed);
        if target.first_pts.is_none() {
            target.first_pts = pts_seconds(sample.output_presentation_timestamp());
        }
        if let Some(file) = target.file.as_mut() {
            if let Err(error) = file.write_all(&pcm) {
                capture.error = Some(format!("couldn't write captured audio: {error}"));
                return;
            }
            target.samples += (pcm.len() / 2) as u64;
        }
    }

    fn wav_header(samples: u64) -> Result<[u8; 44]> {
        let data_len = samples
            .checked_mul(2)
            .and_then(|n| u32::try_from(n).ok())
            .ok_or_else(|| Error::Other("recording is too long for a WAV file".into()))?;
        let mut header = [0_u8; 44];
        header[0..4].copy_from_slice(b"RIFF");
        header[4..8].copy_from_slice(&(36_u32 + data_len).to_le_bytes());
        header[8..12].copy_from_slice(b"WAVE");
        header[12..16].copy_from_slice(b"fmt ");
        header[16..20].copy_from_slice(&16_u32.to_le_bytes());
        header[20..22].copy_from_slice(&1_u16.to_le_bytes());
        header[22..24].copy_from_slice(&1_u16.to_le_bytes());
        header[24..28].copy_from_slice(&(SAMPLE_RATE as u32).to_le_bytes());
        header[28..32].copy_from_slice(&((SAMPLE_RATE * 2) as u32).to_le_bytes());
        header[32..34].copy_from_slice(&2_u16.to_le_bytes());
        header[34..36].copy_from_slice(&16_u16.to_le_bytes());
        header[36..40].copy_from_slice(b"data");
        header[40..44].copy_from_slice(&data_len.to_le_bytes());
        Ok(header)
    }

    fn read_i16(reader: &mut BufReader<File>) -> Result<Option<i16>> {
        let mut bytes = [0_u8; 2];
        match reader.read_exact(&mut bytes) {
            Ok(()) => Ok(Some(i16::from_le_bytes(bytes))),
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    fn mix_to_wav(handle: &Handle) -> Result<(u64, f64)> {
        let (system_first, microphone_first, system_samples, microphone_samples, capture_error) = {
            let mut state = handle
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(file) = state.system.file.as_mut() {
                file.flush()?;
            }
            if let Some(file) = state.microphone.file.as_mut() {
                file.flush()?;
            }
            (
                state.system.first_pts,
                state.microphone.first_pts,
                state.system.samples,
                state.microphone.samples,
                state.error.clone(),
            )
        };
        if let Some(error) = capture_error {
            return Err(Error::Other(error));
        }
        if system_samples == 0 && microphone_samples == 0 {
            return Err(Error::Other(
                "No microphone or system audio was captured.".into(),
            ));
        }

        let first = match (system_first, microphone_first) {
            (Some(a), Some(b)) => a.min(b),
            (Some(a), None) => a,
            (None, Some(b)) => b,
            (None, None) => 0.0,
        };
        let system_offset = system_first
            .map(|v| ((v - first).max(0.0) * SAMPLE_RATE as f64).round() as u64)
            .unwrap_or(0);
        let microphone_offset = microphone_first
            .map(|v| ((v - first).max(0.0) * SAMPLE_RATE as f64).round() as u64)
            .unwrap_or(0);
        let total_samples =
            (system_offset + system_samples).max(microphone_offset + microphone_samples);

        let mut system = BufReader::new(File::open(&handle.system_path)?);
        let mut microphone = BufReader::new(File::open(&handle.microphone_path)?);
        let mut output = BufWriter::new(File::create(&handle.output_path)?);
        output.write_all(&wav_header(total_samples)?)?;
        let mut system_value = None;
        let mut microphone_value = None;
        for index in 0..total_samples {
            if index >= system_offset && system_value.is_none() {
                system_value = read_i16(&mut system)?;
            }
            if index >= microphone_offset && microphone_value.is_none() {
                microphone_value = read_i16(&mut microphone)?;
            }
            let mixed = (system_value.unwrap_or(0) as i32 + microphone_value.unwrap_or(0) as i32)
                .clamp(i16::MIN as i32, i16::MAX as i32) as i16;
            output.write_all(&mixed.to_le_bytes())?;
            system_value = None;
            microphone_value = None;
        }
        output.flush()?;
        Ok((total_samples, total_samples as f64 / SAMPLE_RATE as f64))
    }

    // Read only the new samples; disk remains the source of truth for long takes.
    pub fn chunk(cursor: u64, preserve_silence: bool) -> Result<NativeChunk> {
        let active = ACTIVE.lock().unwrap();
        let handle = active
            .as_ref()
            .ok_or_else(|| Error::Other("no active recording".into()))?;
        let state = handle.state.lock().unwrap();
        if let Some(error) = &state.error {
            return Err(Error::Other(error.clone()));
        }
        let first = match (state.system.first_pts, state.microphone.first_pts) {
            (Some(a), Some(b)) => a.min(b),
            (Some(a), None) | (None, Some(a)) => a,
            _ => {
                return Ok(NativeChunk {
                    audio: vec![],
                    cursor,
                })
            }
        };
        let offset = |source: &SourceState| {
            source
                .first_pts
                .map(|pts| ((pts - first).max(0.0) * SAMPLE_RATE as f64).round() as u64)
                .unwrap_or(0)
        };
        let system_offset = offset(&state.system);
        let mic_offset = offset(&state.microphone);
        let system_end = system_offset + state.system.samples;
        let mic_end = mic_offset + state.microphone.samples;
        let available = system_end.max(mic_end);
        if cursor > available {
            return Err(Error::Other("Invalid live audio cursor".into()));
        }
        // Wait for both callbacks before consuming mixed audio; drain the full
        // tail once capture has been paused for Stop.
        let end = if !handle.paused.load(Ordering::Relaxed)
            && state.system.samples > 0
            && state.microphone.samples > 0
        {
            system_end.min(mic_end).max(cursor)
        } else {
            available
        };
        let sources = [
            (
                handle.system_path.as_path(),
                system_offset,
                state.system.samples,
            ),
            (
                handle.microphone_path.as_path(),
                mic_offset,
                state.microphone.samples,
            ),
        ];
        drop(state);
        read_caption_window(sources, cursor, end, preserve_silence)
    }

    fn read_caption_window(
        sources: [(&std::path::Path, u64, u64); 2],
        cursor: u64,
        end: u64,
        preserve_silence: bool,
    ) -> Result<NativeChunk> {
        if cursor > end {
            return Err(Error::Other("Invalid live audio cursor".into()));
        }
        if end - cursor > SAMPLE_RATE * 120 {
            return Err(Error::Other("Live captions are more than two minutes behind. Close and reopen captions to resume; the full recording is retained.".into()));
        }
        let mut mixed = vec![0_i32; (end - cursor) as usize];
        for (path, offset, samples) in sources {
            let start = cursor.max(offset);
            let source_end = end.min(offset + samples);
            if start >= source_end {
                continue;
            }
            let mut file = File::open(path)?;
            file.seek(SeekFrom::Start((start - offset) * 2))?;
            let mut bytes = vec![0_u8; ((source_end - start) * 2) as usize];
            file.read_exact(&mut bytes)?;
            for (i, raw) in bytes.chunks_exact(2).enumerate() {
                mixed[(start - cursor) as usize + i] += i16::from_le_bytes([raw[0], raw[1]]) as i32;
            }
        }
        let mut audio = Vec::new();
        if !mixed.is_empty() && (preserve_silence || mixed.iter().any(|v| v.abs() > 196)) {
            audio.extend_from_slice(&wav_header(mixed.len() as u64)?);
            for value in mixed {
                audio.extend_from_slice(
                    &(value.clamp(i16::MIN as i32, i16::MAX as i32) as i16).to_le_bytes(),
                );
            }
        }
        Ok(NativeChunk { audio, cursor: end })
    }

    fn remove_capture_files(handle: &Handle, include_output: bool) {
        let _ = std::fs::remove_file(&handle.system_path);
        let _ = std::fs::remove_file(&handle.microphone_path);
        if include_output {
            let _ = std::fs::remove_file(&handle.output_path);
        }
    }

    pub fn start(include_microphone: bool) -> Result<()> {
        if ACTIVE.lock().unwrap().is_some() {
            return Err(Error::Other("A recording is already running.".into()));
        }
        let dir = rec_dir();
        std::fs::create_dir_all(&dir)?;
        let id = crate::db::new_id();
        let system_path = dir.join(format!("rec-{id}-system.pcm"));
        let microphone_path = dir.join(format!("rec-{id}-microphone.pcm"));
        let output_path = dir.join(format!("rec-{id}.wav"));
        let mut pending_files = PendingFiles {
            system_path: system_path.clone(),
            microphone_path: microphone_path.clone(),
            output_path: output_path.clone(),
            committed: false,
        };
        let state = Arc::new(Mutex::new(CaptureState {
            system: SourceState {
                file: Some(File::create(&system_path)?),
                ..Default::default()
            },
            microphone: SourceState {
                file: Some(File::create(&microphone_path)?),
                ..Default::default()
            },
            error: None,
        }));
        let paused = Arc::new(AtomicBool::new(false));
        let level = Arc::new(AtomicU32::new(0.0_f32.to_bits()));

        let content = SCShareableContent::get().map_err(|error| {
            Error::Other(format!("System audio permission is unavailable: {error}. Enable Cortex in System Settings → Privacy & Security → Screen & System Audio Recording, then retry."))
        })?;
        let display = content.displays().into_iter().next().ok_or_else(|| {
            Error::Other("No display is available for system audio capture.".into())
        })?;
        let filter = SCContentFilter::create()
            .with_display(&display)
            .with_excluding_windows(&[])
            .build();
        let config = SCStreamConfiguration::new()
            .with_width(2)
            .with_height(2)
            .with_minimum_frame_interval(&CMTime::new(1, 1))
            .with_shows_cursor(false)
            .with_captures_audio(true)
            .with_captures_microphone(include_microphone)
            .with_excludes_current_process_audio(true)
            .with_sample_rate(SAMPLE_RATE as i32)
            .with_channel_count(1);
        let mut stream = SCStream::new(&filter, &config);

        let system_state = Arc::clone(&state);
        let system_paused = Arc::clone(&paused);
        let system_level = Arc::clone(&level);
        stream
            .add_output_handler(
                move |sample, _| {
                    write_sample(
                        &system_state,
                        &system_paused,
                        &system_level,
                        Source::System,
                        sample,
                    )
                },
                SCStreamOutputType::Audio,
            )
            .ok_or_else(|| {
                Error::Other("ScreenCaptureKit could not attach the system-audio stream.".into())
            })?;

        if include_microphone {
            let microphone_state = Arc::clone(&state);
            let microphone_paused = Arc::clone(&paused);
            let microphone_level = Arc::clone(&level);
            stream
                .add_output_handler(
                    move |sample, _| {
                        write_sample(
                            &microphone_state,
                            &microphone_paused,
                            &microphone_level,
                            Source::Microphone,
                            sample,
                        )
                    },
                    SCStreamOutputType::Microphone,
                )
                .ok_or_else(|| {
                    Error::Other(
                        "Microphone capture requires macOS 15 or later and microphone permission."
                            .into(),
                    )
                })?;
        }

        stream.start_capture().map_err(|error| Error::Other(format!(
            "Couldn't start microphone and system audio capture: {error}. Allow Cortex under Microphone and Screen & System Audio Recording in System Settings, then retry."
        )))?;
        let mut active = ACTIVE.lock().unwrap();
        if active.is_some() {
            let _ = stream.stop_capture();
            return Err(Error::Other("A recording is already running.".into()));
        }
        *active = Some(Handle {
            stream,
            state,
            paused,
            level,
            system_path,
            microphone_path,
            output_path,
        });
        pending_files.committed = true;
        Ok(())
    }

    pub fn pause() -> Result<()> {
        let active = ACTIVE.lock().unwrap();
        let handle = active
            .as_ref()
            .ok_or_else(|| Error::Other("no active recording".into()))?;
        handle.paused.store(true, Ordering::Relaxed);
        Ok(())
    }

    pub fn resume() -> Result<()> {
        let active = ACTIVE.lock().unwrap();
        let handle = active
            .as_ref()
            .ok_or_else(|| Error::Other("no active recording".into()))?;
        handle.paused.store(false, Ordering::Relaxed);
        Ok(())
    }

    pub fn stop() -> Result<NativeRecording> {
        let handle = ACTIVE
            .lock()
            .unwrap()
            .take()
            .ok_or_else(|| Error::Other("no active recording".into()))?;
        if let Err(error) = handle.stream.stop_capture() {
            remove_capture_files(&handle, true);
            return Err(Error::Other(format!(
                "couldn't stop system audio capture: {error}"
            )));
        }
        let secs = match mix_to_wav(&handle) {
            Ok((_, secs)) => secs,
            Err(error) => {
                remove_capture_files(&handle, true);
                return Err(error);
            }
        };
        remove_capture_files(&handle, false);
        Ok(NativeRecording {
            path: handle.output_path.to_string_lossy().into_owned(),
            secs,
            ext: "wav".into(),
        })
    }

    pub fn cancel() -> Result<()> {
        if let Some(handle) = ACTIVE.lock().unwrap().take() {
            let _ = handle.stream.stop_capture();
            remove_capture_files(&handle, true);
        }
        Ok(())
    }

    pub fn meter() -> Result<NativeMeter> {
        let active = ACTIVE.lock().unwrap();
        let handle = active
            .as_ref()
            .ok_or_else(|| Error::Other("no active recording".into()))?;
        let state = handle
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        Ok(NativeMeter {
            level: f32::from_bits(handle.level.load(Ordering::Relaxed)).clamp(0.0, 1.0),
            secs: state.system.samples.max(state.microphone.samples) as f64 / SAMPLE_RATE as f64,
        })
    }
    #[cfg(test)]
    mod caption_tests {
        use super::*;

        #[test]
        fn resampling_is_stable_across_callback_boundaries() {
            let input = (0..48_000)
                .map(|index| (index as f32 / 17.0).sin())
                .collect::<Vec<_>>();
            let mut whole_resampler = PcmResampler::default();
            let whole = whole_resampler.push(&input, 48_000).unwrap();
            let mut fragmented_resampler = PcmResampler::default();
            let fragmented = input
                .chunks(317)
                .flat_map(|chunk| fragmented_resampler.push(chunk, 48_000).unwrap())
                .collect::<Vec<_>>();
            assert_eq!(whole.len(), 16_000);
            assert_eq!(fragmented, whole);
            assert!(fragmented_resampler.push(&[0.0], 44_100).is_err());
        }

        #[test]
        fn live_windows_align_mix_clip_and_flush_without_repeating_samples() {
            let dir =
                std::env::temp_dir().join(format!("cortex-caption-test-{}", crate::db::new_id()));
            std::fs::create_dir_all(&dir).unwrap();
            let system = dir.join("system.pcm");
            let mic = dir.join("mic.pcm");
            let encode = |samples: &[i16]| {
                samples
                    .iter()
                    .flat_map(|s| s.to_le_bytes())
                    .collect::<Vec<_>>()
            };
            std::fs::write(&system, encode(&[1000, 30000, -30000, 4000])).unwrap();
            std::fs::write(&mic, encode(&[10000, -10000])).unwrap();
            let sources = [(system.as_path(), 0, 4), (mic.as_path(), 1, 2)];
            let first = read_caption_window(sources, 0, 2, false).unwrap();
            let tail = read_caption_window(sources, first.cursor, 4, false).unwrap();
            assert_eq!(&first.audio[..4], b"RIFF");
            assert_eq!(&first.audio[44..], encode(&[1000, 32767]));
            assert_eq!(&tail.audio[44..], encode(&[-32768, 4000]));
            assert!(read_caption_window(sources, 4, 4, false)
                .unwrap()
                .audio
                .is_empty());
            assert!(read_caption_window(sources, 5, 4, false).is_err());
            assert!(read_caption_window(sources, 0, SAMPLE_RATE * 121, false).is_err());
            // System-only input leaves the microphone file unopened.
            let single = read_caption_window(
                [(system.as_path(), 0, 4), (mic.as_path(), 0, 0)],
                0,
                4,
                false,
            )
            .unwrap();
            let silent = [(system.as_path(), 0, 0), (mic.as_path(), 0, 0)];
            assert!(read_caption_window(silent, 0, 4, false)
                .unwrap()
                .audio
                .is_empty());
            assert_eq!(
                read_caption_window(silent, 0, 4, true).unwrap().audio.len(),
                52
            );
            assert_eq!(&single.audio[44..], encode(&[1000, 30000, -30000, 4000]));
            std::fs::remove_dir_all(dir).unwrap();
        }
    }
}

// ───────────────────────────── commands ─────────────────────────────
// Thin cross-platform wrappers: real work on iOS, honest errors elsewhere.

#[cfg(not(any(target_os = "ios", target_os = "macos")))]
fn unsupported<T>() -> Result<T> {
    Err(Error::Unsupported(
        "native recording only exists on iOS — this platform records in the webview".into(),
    ))
}

// async: start blocks waiting for the user to answer the mic-permission dialog
// (up to two minutes) — a sync command would freeze the webview for the wait,
// and could deadlock if the permission callback needs the main run loop.
#[tauri::command]
pub async fn native_rec_start(
    include_microphone: Option<bool>,
    include_system_audio: Option<bool>,
) -> Result<()> {
    #[cfg(target_os = "ios")]
    return tauri::async_runtime::spawn_blocking(ios::start)
        .await
        .map_err(|e| Error::Other(format!("recorder task failed: {e}")))?;
    #[cfg(target_os = "macos")]
    return if include_system_audio.unwrap_or(false) {
        let include_microphone = include_microphone.unwrap_or(true);
        tauri::async_runtime::spawn_blocking(move || macos::start(include_microphone))
            .await
            .map_err(|e| Error::Other(format!("recorder task failed: {e}")))?
    } else {
        Err(Error::Unsupported(
            "native macOS recording is only used when system audio is enabled".into(),
        ))
    };
    #[cfg(not(any(target_os = "ios", target_os = "macos")))]
    unsupported()
}

#[tauri::command]
pub fn native_rec_pause() -> Result<()> {
    #[cfg(target_os = "ios")]
    return ios::pause();
    #[cfg(target_os = "macos")]
    return macos::pause();
    #[cfg(not(any(target_os = "ios", target_os = "macos")))]
    unsupported()
}

#[tauri::command]
pub fn native_rec_resume() -> Result<()> {
    #[cfg(target_os = "ios")]
    return ios::resume();
    #[cfg(target_os = "macos")]
    return macos::resume();
    #[cfg(not(any(target_os = "ios", target_os = "macos")))]
    unsupported()
}

#[tauri::command]
pub fn native_rec_stop() -> Result<NativeRecording> {
    #[cfg(target_os = "ios")]
    return ios::stop();
    #[cfg(target_os = "macos")]
    return macos::stop();
    #[cfg(not(any(target_os = "ios", target_os = "macos")))]
    unsupported()
}

#[tauri::command]
pub fn native_rec_cancel() -> Result<()> {
    #[cfg(target_os = "ios")]
    return ios::cancel();
    #[cfg(target_os = "macos")]
    return macos::cancel();
    #[cfg(not(any(target_os = "ios", target_os = "macos")))]
    unsupported()
}

#[tauri::command]
pub fn native_rec_level() -> Result<NativeMeter> {
    #[cfg(target_os = "ios")]
    return ios::meter();
    #[cfg(target_os = "macos")]
    return macos::meter();
    #[cfg(not(any(target_os = "ios", target_os = "macos")))]
    unsupported()
}

#[tauri::command]
pub fn native_rec_chunk(cursor: u64, preserve_silence: Option<bool>) -> Result<NativeChunk> {
    #[cfg(target_os = "macos")]
    return macos::chunk(cursor, preserve_silence.unwrap_or(false));
    #[cfg(not(target_os = "macos"))]
    Err(Error::Unsupported(
        "Live native captions require macOS".into(),
    ))
}
