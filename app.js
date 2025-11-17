import "dotenv/config";
import { getConfig, setConfig, prepareDatabase, db } from "./db.js";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionsBitField,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from "discord.js";
import express from "express";
import session from "express-session";
import FileStore from "session-file-store";
import passport from "passport";
import { Strategy as DiscordStrategy } from "passport-discord";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";
import bodyParser from "body-parser";
import fs from "fs";
import { handleJellyfinWebhook } from "./jellyfinWebhook.js";

// --- INITIAL SETUP ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure data directory exists
const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

prepareDatabase();

// --- ENV VARIABLES ---
const {
  DISCORD_TOKEN,
  BOT_ID,
  DISCORD_CLIENT_SECRET,
  PUBLIC_BOT_URL,
  SESSION_SECRET,
  WEBHOOK_PORT,
  TMDB_API_KEY,
  OMDB_API_KEY,
} = process.env;

// --- DISCORD BOT CLIENT ---
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// --- EXPRESS WEB SERVER ---
const app = express();
app.set('trust proxy', 1); // Trust reverse proxy headers
app.use(bodyParser.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "web")));

const Store = FileStore(session);
app.use(
  session({
    store: new Store({
      dir: path.join(__dirname, "data", "sessions"),
      ttl: 7 * 24 * 60 * 60, // 7 days in seconds
    }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      secure: true, // Set to true if using HTTPS
      sameSite: 'lax',
      httpOnly: true,
    },
  })
);
app.use(passport.initialize());
app.use(passport.session());
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));
passport.use(
  new DiscordStrategy(
    {
      clientID: BOT_ID,
      clientSecret: DISCORD_CLIENT_SECRET,
      callbackURL: `${PUBLIC_BOT_URL}/auth/callback`,
      scope: ["identify", "guilds"],
      passReqToCallback: true,
    },
    (req, accessToken, refreshToken, profile, done) => {
      return done(null, profile);
    }
  )
);
function ensureAuthenticated(req, res, next) {
  // Redirect to login page if not authenticated
  if (req.isAuthenticated()) return next();
  res.redirect("/discord-bot.html");
}
app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "web", "index.html"))
);
app.get("/discord-bot", (req, res) =>
  res.sendFile(path.join(__dirname, "web", "discord-bot.html"))
);

// Generic login route
app.get("/login", passport.authenticate("discord"));

// Specific login route from Discord /setup command
app.get("/auth/discord", (req, res, next) => {
  const guildId = req.query.guild_id;
  if (!guildId)
    return res.status(400).send("Error: Missing guild_id parameter.");

  // Check if the bot is actually in the guild before attempting to auth for it.
  if (!client.guilds.cache.has(guildId)) {
    const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${BOT_ID}&permissions=3264&scope=bot%20applications.commands&guild_id=${guildId}`;
    // Redirect the user to invite the bot to that specific server.
    return res.redirect(inviteUrl);
  }

  // Store guildId in session to redirect after login
  req.session.guildId = guildId;
  passport.authenticate("discord")(req, res, next);
});

app.get(
  "/auth/callback",
  passport.authenticate("discord", { failureRedirect: "/" }),
  (req, res) => {
    // If we have a specific guildId from the /setup command, pass it along
    if (req.session.guildId) {
      const guildId = req.session.guildId;
      req.session.guildId_to_redirect = guildId; // Store it temporarily
      delete req.session.guildId;
      req.session.save(() => {
        res.redirect(
          `/dashboard.html?guild_id=${req.session.guildId_to_redirect}`
        );
      });
    } else {
      // Otherwise, just go to the generic dashboard
      req.session.save(() => {
        res.redirect("/dashboard.html");
      });
    }
  }
);

app.get("/logout", (req, res) => {
  req.logout(() => {
    res.redirect("/discord-bot.html");
  });
});

app.get("/dashboard.html", ensureAuthenticated, (req, res) =>
  res.sendFile(path.join(__dirname, "web", "dashboard.html"))
);

app.get("/api/config", ensureAuthenticated, (req, res) => {
  const { guild_id: guildId } = req.query;
  if (!guildId)
    return res.status(400).json({ error: "Guild ID is missing from request." });
  const guild = req.user.guilds.find((g) => g.id === guildId);
  if (
    !guild ||
    !new PermissionsBitField(BigInt(guild.permissions)).has("Administrator")
  ) {
    return res
      .status(403)
      .json({ error: "You are not an administrator of this server." });
  }
  const config = getConfig(guildId) || {};
  res.json({ guildName: guild.name, config });
});
app.post("/api/config", ensureAuthenticated, (req, res) => {
  const { guild_id: guildId } = req.body;
  if (!guildId)
    return res.status(400).json({ error: "Guild ID not found in submission." });
  const guild = req.user.guilds.find((g) => g.id === guildId);
  if (
    !guild ||
    !new PermissionsBitField(BigInt(guild.permissions)).has("Administrator")
  )
    return res.status(403).json({ error: "Forbidden" });
  const newConfig = {
    guild_id: guildId,
    jellyseer_url: req.body.jellyseer_url,
    jellyseer_api_key: req.body.jellyseer_api_key,
    notification_channel_id: req.body.notification_channel_id,
    jellyfin_server_url: req.body.jellyfin_server_url,
    color_search: req.body.color_search,
    color_success: req.body.color_success,
    color_notification: req.body.color_notification,
    ephemeral_responses: req.body.ephemeral_responses ? 1 : 0,
  };
  setConfig(newConfig);
  res.json({ success: true, message: "Configuration saved!" });
});

// API endpoint to get session info and manageable guilds
app.get("/api/session", ensureAuthenticated, (req, res) => {
  const manageableGuilds = req.user.guilds
    .filter((g) =>
      new PermissionsBitField(BigInt(g.permissions)).has("Administrator")
    )
    .map((g) => ({
      id: g.id,
      name: g.name,
      icon_url: g.icon
        ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png`
        : "https://cdn.discordapp.com/embed/avatars/0.png",
      bot_in_server: client.guilds.cache.has(g.id),
    }));

  res.json({
    user: req.user,
    guilds: manageableGuilds,
    bot_id: BOT_ID,
  });
});

// API endpoint to test service connections
app.post("/api/test-connection", ensureAuthenticated, async (req, res) => {
  const { type, url, apiKey } = req.body;

  if (!url) {
    return res.status(400).json({ message: "URL is required." });
  }

  try {
    if (type === "jellyseerr") {
      if (!apiKey) {
        return res
          .status(400)
          .json({ message: "API Key is required for Jellyseerr." });
      }
      // Test Jellyseerr by fetching its status
      const authTestUrl = new URL("/api/v1/settings/main", url).href;
      await axios.get(authTestUrl, {
        headers: { "X-Api-Key": apiKey },
        timeout: 5000,
      });

      // If the auth test passes, get the public status to find the version
      const statusUrl = new URL("/api/v1/status", url).href;
      const statusResponse = await axios.get(statusUrl, { timeout: 5000 });
      const version = statusResponse.data?.version;

      const message = version
        ? `Successfully connected to Jellyseerr v${version}!`
        : "Successfully connected to Jellyseerr!";
      return res.json({ message });
    } else if (type === "jellyfin") {
      // Test Jellyfin by fetching its system info
      const response = await axios.get(
        `${url.replace(/\/$/, "")}/System/Info/Public`,
        { timeout: 5000 }
      );
      const version = response.data?.Version;
      if (version) {
        return res.json({ message: `Connected to Jellyfin v${version}` });
      }
      throw new Error("Invalid response from Jellyfin.");
    }
    return res.status(400).json({ message: "Invalid connection type." });
  } catch (error) {
    const errorMessage =
      error.response?.data?.message ||
      error.message ||
      "Could not connect. Check URL and CORS settings.";
    return res.status(500).json({ message: errorMessage });
  }
});

// --- BOT HELPER FUNCTIONS ---
const tmdbSearch = async (query) => {
  const { data } = await axios.get(
    "https://api.themoviedb.org/3/search/multi",
    { params: { api_key: TMDB_API_KEY, query, include_adult: false } }
  );
  return data.results || [];
};
const tmdbGetDetails = async (id, mediaType) => {
  const { data } = await axios.get(
    `https://api.themoviedb.org/3/${mediaType}/${id}`,
    {
      params: {
        api_key: TMDB_API_KEY,
        append_to_response: "images,credits",
      },
    }
  );
  return data;
};

const tmdbGetExternalImdb = async (id, mediaType) => {
  const url =
    mediaType === "movie"
      ? `https://api.themoviedb.org/3/movie/${id}/external_ids`
      : `https://api.themoviedb.org/3/tv/${id}/external_ids`;
  const res = await axios.get(url, { params: { api_key: TMDB_API_KEY } });
  return res.data.imdb_id || null;
};
const sendRequestToJellyseerr = async (
  tmdbId,
  mediaType,
  config,
  seasons = []
) => {
  const payload = { mediaId: parseInt(tmdbId, 10), mediaType };
  if (mediaType === "tv") {
    if (seasons.length > 0) {
      payload.seasons = seasons;
    } else {
      payload.seasons = "all";
    }
  }
  const baseUrl = config.jellyseer_url
    .replace(/\/$/, "")
    .replace(/\/api\/v1$/, "");
  await axios.post(`${baseUrl}/api/v1/request`, payload, {
    headers: { "X-Api-Key": config.jellyseer_api_key },
  });
};
const fetchOMDbData = async (imdbId) => {
  if (!imdbId || !OMDB_API_KEY) return null;
  try {
    const { data } = await axios.get(
      `http://www.omdbapi.com/?i=${imdbId}&apikey=${OMDB_API_KEY}`
    );
    return data.Response === "True" ? data : null;
  } catch (error) {
    console.warn("OMDb fetch failed:", error.message);
    return null;
  }
};
const minutesToHhMm = (minutes) => {
  if (isNaN(minutes) || minutes <= 0) return "N/A";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${m}m`;
};
const findBestBackdrop = (details) => {
  if (details.images?.backdrops?.length > 0) {
    const englishBackdrop = details.images.backdrops.find(
      (b) => b.iso_639_1 === "en"
    );
    if (englishBackdrop) return englishBackdrop.file_path;
  }
  return details.backdrop_path;
};

// --- EMBED & BUTTON BUILDERS ---
const buildMediaEmbed = (
  details,
  mediaType,
  status,
  config,
  omdbData,
  backdropPath
) => {
  const title = details.title || details.name;
  const year = (details.release_date || details.first_air_date)?.slice(0, 4);
  const fullTitle = year ? `${title} (${year})` : title;
  let authorName, color;
  switch (status) {
    case "success":
      authorName = "✅ Successfully Requested!";
      color = config.color_success || "#a6d189";
      break;
    case "search":
      authorName =
        mediaType === "movie" ? "🎬 Movie Found" : "📺 TV Show Found";
      color = config.color_search || "#ef9f76";
      break;
    default:
      authorName = "Item Details";
      color = config.color_search || "#ef9f76";
  }
  const overview = details.overview || "No description available.";
  const imdbId = details.external_ids?.imdb_id;
  const embed = new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: authorName })
    .setTitle(fullTitle)
    .setURL(imdbId ? `https://www.imdb.com/title/${imdbId}/` : null)
    .setImage(
      backdropPath ? `https://image.tmdb.org/t/p/w780${backdropPath}` : null
    );

  let headerLine = "Summary";
  if (
    mediaType === "movie" &&
    omdbData?.Director &&
    omdbData.Director !== "N/A"
  ) {
    headerLine = `Directed by ${omdbData.Director}`;
  } else if (mediaType === "tv" && details.credits?.crew) {
    const creator = details.credits.crew.find(
      (c) => c.job === "Creator" || c.job === "Executive Producer"
    );
    if (creator) {
      headerLine = `Created by ${creator.name}`;
    }
  }
  embed.addFields({
    name: headerLine,
    value:
      overview.length > 1024 ? overview.substring(0, 1021) + "..." : overview,
  });
  const genres = details.genres?.map((g) => g.name).join(", ") || "N/A";

  let runtime = "N/A";
  if (mediaType === "movie") {
    runtime = minutesToHhMm(details.runtime);
  } else if (mediaType === "tv") {
    // For TV shows, get episode duration from OMDb
    if (omdbData?.Runtime && omdbData.Runtime !== "N/A") {
      const match = String(omdbData.Runtime).match(/(\d+)/);
      if (match) {
        runtime = `${match[1]} min`;
      }
    }
  }

  const rating =
    omdbData?.imdbRating && omdbData.imdbRating !== "N/A"
      ? `${omdbData.imdbRating}/10`
      : "N/A";
  embed.addFields(
    { name: "Genre", value: genres, inline: true },
    { name: "Runtime", value: runtime, inline: true },
    { name: "Rating", value: rating, inline: true }
  );
  return embed;
};
const buildActionButtons = (
  tmdbId,
  mediaType,
  imdbId,
  requested = false,
  details = null,
  requestedSeasons = []
) => {
  const buttons = [];

  if (imdbId) {
    buttons.push(
      new ButtonBuilder()
        .setLabel("Letterboxd")
        .setStyle(ButtonStyle.Link)
        .setURL(`https://letterboxd.com/imdb/${imdbId}`),
      new ButtonBuilder()
        .setLabel("IMDb")
        .setStyle(ButtonStyle.Link)
        .setURL(`https://www.imdb.com/title/${imdbId}`)
    );
  }

  const rows = [];

  // For TV shows in search mode, show season selection dropdown
  if (
    mediaType === "tv" &&
    details?.seasons?.length > 0 &&
    requestedSeasons.length === 0 &&
    !requested
  ) {
    const seasonOptions = details.seasons
      .filter((s) => s.season_number > 0)
      .slice(0, 24) // Max 24 + 1 for "All Seasons" = 25 total
      .map((s) => {
        const episodeCount = s.episode_count || 0;
        return new StringSelectMenuOptionBuilder()
          .setLabel(`Season ${s.season_number}`)
          .setValue(`${s.season_number}`)
          .setDescription(
            `${episodeCount} episode${episodeCount !== 1 ? "s" : ""}`
          );
      });

    // Add "Request All Seasons" as first option
    const allSeasonsOption = new StringSelectMenuOptionBuilder()
      .setLabel("Request All Seasons")
      .setValue("all");

    if (seasonOptions.length > 0) {
      // Add dropdown menu (buttons will be added at the end)
      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`seasonselect|${tmdbId}`)
        .setPlaceholder("Select season(s) to request")
        .setMinValues(1)
        .setMaxValues(Math.min(seasonOptions.length + 1, 25))
        .addOptions([allSeasonsOption, ...seasonOptions]);

      rows.push(new ActionRowBuilder().addComponents(selectMenu));
    }
  }

  // Add action buttons based on state
  if (requestedSeasons.length > 0) {
    // Seasons were requested - show which ones
    let seasonLabel;
    if (requestedSeasons.includes("all")) {
      seasonLabel = "All Seasons";
    } else if (requestedSeasons.length === 1) {
      seasonLabel = `Season ${requestedSeasons[0]}`;
    } else {
      const lastSeason = requestedSeasons.pop();
      seasonLabel = `Seasons ${requestedSeasons.join(", ")} and ${lastSeason}`;
    }
    buttons.push(
      new ButtonBuilder()
        .setCustomId("requested")
        .setLabel(`Requested ${seasonLabel}`)
        .setStyle(ButtonStyle.Success)
        .setDisabled(true)
    );
  } else if (requested) {
    // Simple requested state (movies or TV shows from /request command)
    buttons.push(
      new ButtonBuilder()
        .setCustomId("requested")
        .setLabel("Requested, stay tuned!")
        .setStyle(ButtonStyle.Success)
        .setDisabled(true)
    );
  } else if (mediaType === "tv" && details?.seasons?.length > 0) {
    // TV show in search mode - dropdown is already added above, no request button needed
  } else {
    // Default request button (for movies or TV shows without seasons data)
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`request|${tmdbId}|${mediaType}`)
        .setLabel("Request")
        .setStyle(ButtonStyle.Primary)
    );
  }

  // Add buttons row at the beginning (for external links and action buttons)
  if (buttons.length > 0) {
    const mainRow = new ActionRowBuilder().addComponents(buttons);
    rows.unshift(mainRow);
  }

  return rows;
};

// --- DISCORD COMMANDS DEFINITION ---
const commands = [
  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Get a link to configure the bot on the web dashboard."),
  new SlashCommandBuilder()
    .setName("search")
    .setDescription("Search for a movie or TV show.")
    .addStringOption((opt) =>
      opt
        .setName("title")
        .setDescription("The title to search for")
        .setRequired(true)
        .setAutocomplete(true)
    ),
  new SlashCommandBuilder()
    .setName("request")
    .setDescription("Request a movie or TV show directly.")
    .addStringOption((opt) =>
      opt
        .setName("title")
        .setDescription("The title to request")
        .setRequired(true)
        .setAutocomplete(true)
    ),
];

// --- DISCORD EVENTS ---
const handleInteraction = async (
  interaction,
  tmdbId,
  mediaType,
  isRequest,
  seasons = []
) => {
  const config = getConfig(interaction.guildId);
  try {
    if (isRequest)
      await sendRequestToJellyseerr(tmdbId, mediaType, config, seasons);
    const details = await tmdbGetDetails(tmdbId, mediaType);
    const imdbId = await tmdbGetExternalImdb(tmdbId, mediaType);
    const omdbData = await fetchOMDbData(imdbId);
    const bestBackdropPath = findBestBackdrop(details);
    const embed = buildMediaEmbed(
      details,
      mediaType,
      isRequest ? "success" : "search",
      config,
      omdbData,
      bestBackdropPath
    );
    const components = buildActionButtons(
      tmdbId,
      mediaType,
      imdbId,
      isRequest,
      details,
      seasons
    );
    await interaction.editReply({ embeds: [embed], components });
  } catch (error) {
    console.error(
      "Error during interaction:",
      error.response?.data || error.message
    );
    const errorMessage =
      "❌ An error occurred. The item might already be requested.";
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({
        content: errorMessage,
        embeds: [],
        components: [],
      });
    }
  }
};

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      const focusedValue = interaction.options.getFocused();
      if (focusedValue.length < 2) return await interaction.respond([]);
      const results = await tmdbSearch(focusedValue);
      const choices = await Promise.all(
        results
          .filter(
            (r) => ["movie", "tv"].includes(r.media_type) && r.poster_path
          )
          .slice(0, 10)
          .map(async (item) => {
            const year = (item.release_date || item.first_air_date)?.slice(
              0,
              4
            );
            let extraInfo = "";
            try {
              const details = await tmdbGetDetails(item.id, item.media_type);
              if (item.media_type === "movie") {
                // Director
                const director = details.credits?.crew?.find(
                  (c) => c.job === "Director"
                );
                const directorName = director ? `directed by ${director.name}` : "";
                
                // Runtime
                let runtimeText = "";
                if (details.runtime) {
                  runtimeText = `runtime: ${minutesToHhMm(details.runtime)}`;
                }
                
                // Combine
                const parts = [directorName, runtimeText].filter(Boolean);
                if (parts.length > 0) {
                  extraInfo = ` — ${parts.join(" — ")}`;
                }
              } else if (item.media_type === "tv") {
                // Creator
                const creator = details.created_by?.[0];
                const creatorName = creator ? `created by ${creator.name}` : "";
                
                // Season count
                let seasonText = "";
                if (details.number_of_seasons) {
                  const s = details.number_of_seasons;
                  seasonText = `${s} season${s > 1 ? "s" : ""}`;
                }
                
                // Combine
                const parts = [creatorName, seasonText].filter(Boolean);
                if (parts.length > 0) {
                  extraInfo = ` — ${parts.join(" — ")}`;
                }
              }
            } catch (e) {
              // Ignore errors in autocomplete
            }
            let label = `${item.media_type === "movie" ? "🎬" : "📺"} ${
              item.title || item.name
            }${year ? ` (${year})` : ""}${extraInfo}`;
            
            // Truncate to 95 characters + "..." if too long
            if (label.length > 100) {
              label = label.substring(0, 95) + "...";
            }
            
            return {
              name: label,
              value: `${item.id}|${item.media_type}`,
            };
          })
      );
      await interaction.respond(choices);
      return;
    }

    if (interaction.isCommand()) {
      const { commandName } = interaction;
      const config = getConfig(interaction.guildId);
      if (commandName === "setup") {
        if (
          !interaction.member.permissions.has(
            PermissionsBitField.Flags.Administrator
          )
        ) {
          return interaction.reply({
            content: "Only administrators can use this command.",
            flags: 64,
          });
        }
        const dashboardUrl = `${PUBLIC_BOT_URL}/auth/discord?guild_id=${interaction.guildId}`;

        const setupEmbed = new EmbedBuilder()
          .setColor("#cba6f7")
          .setTitle("Configure Anchorr")
          .setDescription(
            "Hey! Welcome to Anchorr setup! Click the button below to configure the bot for this server.\n\n" +
              "**You'll be able to configure:**\n" +
              "• Jellyseerr connection\n" +
              "• Jellyfin notifications\n" +
              "• Custom embed colors\n" +
              "• Notification channel"
          )
          .setFooter({
            text: "You must be logged in with Discord to access the dashboard",
          });

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setLabel("🔗 Open Dashboard")
            .setStyle(ButtonStyle.Link)
            .setURL(dashboardUrl)
        );

        return interaction.reply({
          embeds: [setupEmbed],
          components: [row],
          flags: 64,
        });
      }
      if (!config?.jellyseer_url) {
        return interaction.reply({
          content:
            "⚠️ Anchorr is not configured. An admin needs to run `/setup`.",
          flags: 64,
        });
      }
      await interaction.deferReply({
        flags: config.ephemeral_responses ? 64 : 0,
      });
      const rawValue = interaction.options.getString("title");
      const [tmdbId, mediaType] = rawValue.split("|");
      if (!tmdbId || !mediaType)
        return interaction.editReply({
          content: "⚠️ Please select a valid title from the list.",
        });

      // For /request command, always request all seasons for TV shows
      const seasonsToRequest =
        commandName === "request" && mediaType === "tv" ? "all" : [];

      await handleInteraction(
        interaction,
        tmdbId,
        mediaType,
        commandName === "request",
        seasonsToRequest
      );
    }

    if (interaction.isButton()) {
      if (interaction.customId.startsWith("request|")) {
        await interaction.deferUpdate();
        const [_, tmdbId, mediaType] = interaction.customId.split("|");
        await handleInteraction(interaction, tmdbId, mediaType, true);
      }
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith("seasonselect|")) {
        await interaction.deferUpdate();
        const [_, tmdbId] = interaction.customId.split("|");
        const selectedValues = interaction.values;

        // Check if "all" was selected
        if (selectedValues.includes("all")) {
          await handleInteraction(interaction, tmdbId, "tv", true, "all");
        } else {
          const selectedSeasons = selectedValues.map((v) => parseInt(v));
          await handleInteraction(
            interaction,
            tmdbId,
            "tv",
            true,
            selectedSeasons
          );
        }
      }
    }
  } catch (error) {
    console.error("An unhandled error occurred in interactionCreate:", error);
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({
        content: "There was an error while executing this command!",
        flags: 64,
      });
    } else {
      await interaction.reply({
        content: "There was an error while executing this command!",
        flags: 64,
      });
    }
  }
});

// --- JELLYFIN WEBHOOK HANDLER ---
app.post("/jellyfin-webhook/:guildId", async (req, res) => {
  await handleJellyfinWebhook(req, res, client, getConfig, TMDB_API_KEY, OMDB_API_KEY);
});

// --- STARTUP ---
(async () => {
  try {
    // Validate required environment variables
    if (!DISCORD_TOKEN || !BOT_ID) {
      throw new Error(
        "Missing required environment variables: DISCORD_TOKEN and BOT_ID"
      );
    }

    const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
    console.log("Started refreshing application (/) commands.");

    try {
      await rest.put(Routes.applicationCommands(BOT_ID), {
        body: commands.map((c) => c.toJSON()),
      });
      console.log("Successfully reloaded application (/) commands.");
    } catch (restError) {
      console.warn("Warning: Could not refresh commands:", restError.message);
      console.warn("Continuing with bot startup...");
    }

    await client.login(DISCORD_TOKEN);
    client.once("clientReady", () => {
      console.log(`✅ Discord Bot logged in as ${client.user.tag}`);
      app.listen(WEBHOOK_PORT, () => {
        console.log(
          `🌐 Web server and webhook listener started on port ${WEBHOOK_PORT}`
        );
      });
    });
  } catch (error) {
    console.error("Fatal startup error:", error.message);
    process.exit(1);
  }
})();
