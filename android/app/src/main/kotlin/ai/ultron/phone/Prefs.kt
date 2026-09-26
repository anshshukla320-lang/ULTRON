package ai.ultron.phone

import ai.ultron.core.AssistantConfig
import ai.ultron.core.CookieStore
import ai.ultron.core.MemoryStore
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The app's settings. The PC password, the Anthropic API key and the PC
 * session are encrypted with a key that lives in Android's hardware-backed
 * keystore and never leaves this phone.
 */
class Prefs(context: Context) : MemoryStore, CookieStore {
    private val sp = context.getSharedPreferences("ultron", Context.MODE_PRIVATE)

    var pcUrl: String
        get() = sp.getString("pc_url", "").orEmpty()
        set(v) = sp.edit().putString("pc_url", v.trim()).apply()
    var pcPassword: String
        get() = secret("pc_password")
        set(v) = setSecret("pc_password", v)
    var apiKey: String
        get() = secret("api_key")
        set(v) = setSecret("api_key", v.trim())
    /** Keep listening for a follow-up after ULTRON answers. */
    var handsFree: Boolean
        get() = sp.getBoolean("hands_free", true)
        set(v) = sp.edit().putBoolean("hands_free", v).apply()
    var speakReplies: Boolean
        get() = sp.getBoolean("speak", true)
        set(v) = sp.edit().putBoolean("speak", v).apply()
    /** For WhatsApp numbers written without one, e.g. 91 for India. */
    var countryCode: String
        get() = sp.getString("country_code", "91").orEmpty()
        set(v) = sp.edit().putString("country_code", v.filter(Char::isDigit)).apply()

    fun config() = AssistantConfig(pcUrl, pcPassword, apiKey)

    // ── MemoryStore ──────────────────────────────────────────────────────
    override fun facts(): List<String> = list("facts")
    override fun setFacts(facts: List<String>) = putList("facts", facts)
    override fun pendingFacts(): List<String> = list("pending_facts")
    override fun addPendingFact(fact: String) = putList("pending_facts", pendingFacts() + fact)
    override fun clearPendingFacts(sent: List<String>) = putList("pending_facts", pendingFacts() - sent.toSet())

    // ── CookieStore (the PC session) ─────────────────────────────────────
    override fun get(): String? = secret("pc_cookie").ifEmpty { null }
    override fun set(value: String?) = setSecret("pc_cookie", value.orEmpty())

    private fun list(key: String): List<String> {
        val arr = JSONArray(sp.getString(key, "[]"))
        return List(arr.length()) { arr.getString(it) }
    }

    private fun putList(key: String, items: List<String>) {
        sp.edit().putString(key, JSONArray(items).toString()).apply()
    }

    private fun secret(key: String): String {
        val stored = sp.getString("enc_$key", null) ?: return ""
        return try {
            val bytes = Base64.decode(stored, Base64.NO_WRAP)
            val cipher = Cipher.getInstance(TRANSFORM)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes, 0, 12))
            String(cipher.doFinal(bytes, 12, bytes.size - 12), Charsets.UTF_8)
        } catch (_: Exception) {
            "" // key lost (e.g. restored to a new phone): the user re-enters it
        }
    }

    private fun setSecret(key: String, value: String) {
        if (value.isEmpty()) {
            sp.edit().remove("enc_$key").apply()
            return
        }
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val out = cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        sp.edit().putString("enc_$key", Base64.encodeToString(out, Base64.NO_WRAP)).apply()
    }

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    private companion object {
        const val ALIAS = "ultron_secrets"
        const val TRANSFORM = "AES/GCM/NoPadding"
    }
}
