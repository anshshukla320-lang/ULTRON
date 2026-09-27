package ai.ultron.phone

import ai.ultron.core.PcBrain
import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.IBinder
import android.util.Log
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Records a meeting on the phone's microphone and sends it to ULTRON on the
 * PC in 30-second WAV chunks, which Whisper transcribes as they arrive. A
 * foreground service, so it keeps going with the screen off.
 */
class MeetingService : Service() {
    @Volatile private var stopping = false
    private var recorder: Thread? = null
    private val uploads = Executors.newSingleThreadExecutor()
    private lateinit var pc: PcBrain
    private lateinit var meetingId: String
    private val finished = CountDownLatch(1)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (recorder != null) return START_NOT_STICKY
        meetingId = intent?.getStringExtra(EXTRA_ID) ?: return stopEarly()
        val title = intent.getStringExtra(EXTRA_TITLE).orEmpty().ifBlank { "Meeting" }
        if (!hasPermissions(Manifest.permission.RECORD_AUDIO)) return stopEarly()
        val prefs = Prefs(this)
        val c = prefs.config()
        pc = PcBrain(c.pcUrl, c.pcPassword, prefs)

        Notices.ensureChannels(this)
        val open = PendingIntent.getActivity(this, 2, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE)
        val n = Notification.Builder(this, Notices.CHANNEL_MEETING)
            .setSmallIcon(R.drawable.ic_notify)
            .setColor(getColor(R.color.amber))
            .setContentTitle("Recording \"$title\"")
            .setContentText("Say \"ULTRON, the meeting's over\" when it ends.")
            .setOngoing(true)
            .setContentIntent(open)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        else startForeground(NOTIFICATION_ID, n)

        current = this
        recorder = Thread(::record, "meeting-recorder").also { it.start() }
        return START_NOT_STICKY
    }

    private fun stopEarly(): Int {
        stopSelf()
        return START_NOT_STICKY
    }

    @SuppressLint("MissingPermission") // checked in onStartCommand
    private fun record() {
        val bufSize = maxOf(AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT), RATE)
        val ar = AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufSize)
        val chunk = ByteArrayOutputStream()
        val buf = ByteArray(bufSize)
        try {
            ar.startRecording()
            while (!stopping) {
                val n = ar.read(buf, 0, buf.size)
                if (n > 0) chunk.write(buf, 0, n)
                if (chunk.size() >= CHUNK_BYTES) {
                    upload(chunk.toByteArray(), false)
                    chunk.reset()
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "recording stopped: ${e.message}")
        } finally {
            runCatching { ar.stop() }
            ar.release()
        }
        // The last piece, marked final so the PC knows it has everything.
        upload(chunk.toByteArray(), true)
        uploads.execute { finished.countDown() }
    }

    private val failed = ArrayDeque<ByteArray>()

    private fun upload(pcm: ByteArray, final: Boolean) {
        val wav = wav(pcm)
        uploads.execute {
            // Chunks that failed (PC briefly unreachable) go first, in order.
            failed.addLast(wav)
            while (failed.isNotEmpty()) {
                val next = failed.first()
                val isFinal = final && failed.size == 1
                val ok = (1..3).any { attempt ->
                    try {
                        pc.meetingChunk(meetingId, next, isFinal)
                        true
                    } catch (e: Exception) {
                        Log.w(TAG, "chunk upload failed: ${e.message}")
                        Thread.sleep(2_000L * attempt)
                        false
                    }
                }
                if (!ok) {
                    while (failed.size > 20) failed.removeFirst() // keep the last ~10 minutes
                    return@execute
                }
                failed.removeFirst()
            }
        }
    }

    /** Stops recording and waits until the last chunk is on the PC. */
    private fun finish(timeoutMs: Long): Boolean {
        stopping = true
        val ok = finished.await(timeoutMs, TimeUnit.MILLISECONDS)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
        return ok
    }

    override fun onDestroy() {
        stopping = true
        if (current === this) current = null
        uploads.shutdown()
        super.onDestroy()
    }

    companion object {
        private const val TAG = "UltronMeeting"
        private const val RATE = 16_000
        private const val CHUNK_BYTES = RATE * 2 * 30 // 30 s of 16-bit mono
        private const val NOTIFICATION_ID = 42
        private const val EXTRA_ID = "id"
        private const val EXTRA_TITLE = "title"

        @Volatile private var current: MeetingService? = null

        val recording get() = current != null

        fun start(ctx: Context, id: String, title: String) {
            ctx.startForegroundService(Intent(ctx, MeetingService::class.java).putExtra(EXTRA_ID, id).putExtra(EXTRA_TITLE, title))
        }

        /** Background thread. False if nothing was recording here. */
        fun stop(timeoutMs: Long = 60_000): Boolean {
            val s = current ?: return false
            s.finish(timeoutMs)
            return true
        }

        /** 16 kHz mono 16-bit PCM → WAV. */
        fun wav(pcm: ByteArray): ByteArray {
            val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
            header.put("RIFF".toByteArray()).putInt(36 + pcm.size).put("WAVE".toByteArray())
            header.put("fmt ".toByteArray()).putInt(16).putShort(1).putShort(1).putInt(RATE).putInt(RATE * 2).putShort(2).putShort(16)
            header.put("data".toByteArray()).putInt(pcm.size)
            return header.array() + pcm
        }
    }
}
