// The reaction picker's emoji (vedu: "let me pick what emojis i will use, similar to slack"): a curated set, no fetch.
// Each category is [title, tab icon, "emoji name keyword…|…"]; the first word is the emoji's :shortcode:, the rest are
// what search also matches. Every emoji here must pass the server's EMOJI_RE (test/emoji.test.ts checks).
export const EMOJI: [string, string, string][] = [
  [
    "Smileys & people",
    "😀",
    "😀 grinning smile happy|😃 smiley happy|😄 smile happy joy|😁 grin|😆 laughing lol haha|😅 sweat_smile phew|🤣 rofl lol laughing|😂 joy lol laughing tears|" +
      "🙂 slightly_smiling_face|🙃 upside_down_face|😉 wink|😊 blush happy|😇 innocent halo angel|🥰 smiling_face_with_hearts love|😍 heart_eyes love|🤩 star_struck wow|" +
      "😘 kissing_heart kiss|😋 yum tasty|😛 stuck_out_tongue|🤪 zany_face crazy|🤗 hugs hug|🤭 hand_over_mouth oops|" +
      "🤫 shushing_face quiet secret|🤔 thinking hmm think|🫡 saluting_face salute yes|🤨 raised_eyebrow skeptical|😐 neutral_face meh|" +
      "🫠 melting_face|😏 smirk|😒 unamused|🙄 roll_eyes eyeroll|😬 grimacing awkward yikes|😮‍💨 face_exhaling sigh relief|😌 relieved|😔 pensive sad|" +
      "😪 sleepy|😴 sleeping zzz tired|😷 mask sick|🤢 nauseated_face sick|" +
      "🤯 exploding_head mind_blown wow|🥳 partying_face party celebrate birthday|😎 sunglasses cool|🤓 nerd_face geek|" +
      "🧐 monocle_face inspect review|😕 confused|😟 worried|🙁 slightly_frowning_face sad|😮 open_mouth wow surprised|😲 astonished shocked|😳 flushed embarrassed|" +
      "🥺 pleading_face please puppy|🥹 face_holding_back_tears grateful|😨 fearful scared|😰 cold_sweat nervous|😢 cry sad tear|" +
      "😭 sob crying|😱 scream omg|😞 disappointed|😓 sweat|😩 weary tired|🥱 yawning_face bored|😤 triumph huff|😡 rage angry mad|" +
      "😠 angry mad|💀 skull dead|💩 poop|🤡 clown|👻 ghost|🤖 robot bot agent ai|🙈 see_no_evil monkey|" +
      "👀 eyes look see watching read|🧠 brain smart think|👤 bust_in_silhouette person user|👥 busts_in_silhouette people team|" +
      "🧑‍💻 technologist developer coder dev",
  ],
  [
    "Gestures",
    "👍",
    "👍 +1 thumbsup yes like approve agree lgtm|👎 -1 thumbsdown no dislike|👌 ok_hand ok perfect|🤏 pinching_hand small tiny|✌️ v victory peace|" +
      "🤞 crossed_fingers luck hope|🤘 metal rock|🤙 call_me_hand shaka|👈 point_left|👉 point_right|👆 point_up_2|👇 point_down|☝️ point_up|" +
      "🫵 point_at_viewer you|👋 wave hello hi bye|✋ hand raised_hand stop high_five|" +
      "👏 clap applause bravo|🙌 raised_hands hooray yay celebrate|🫶 heart_hands love thanks|👐 open_hands|🤝 handshake deal agree|🙏 pray please thanks thank_you|" +
      "✍️ writing_hand write|💪 muscle strong flex|👊 punch fist_bump|✊ fist solidarity|🙋 raising_hand question me|" +
      "🙅 no_good no stop|🙆 ok_woman ok|🤷 shrug idk dunno|🤦 facepalm|🙇 bow sorry thanks|🏃 runner run go fast|💃 dancer dance party|" +
      "🕺 man_dancing dance|🧘 yoga calm meditate|👁️ eye look",
  ],
  [
    "Hearts & symbols",
    "❤️",
    "❤️ heart love|🧡 orange_heart|💛 yellow_heart|💚 green_heart|💙 blue_heart|💜 purple_heart|🖤 black_heart|🤍 white_heart|💔 broken_heart|" +
      "❤️‍🔥 heart_on_fire love|💕 two_hearts|💖 sparkling_heart|💯 100 hundred perfect score|✅ white_check_mark check done yes|✔️ heavy_check_mark check|" +
      "❌ x no wrong cross|🛑 stop_sign stop|⛔ no_entry|🚫 no_entry_sign forbidden ban|⚠️ warning caution|❗ exclamation important|" +
      "❓ question|➕ heavy_plus_sign plus add|➖ heavy_minus_sign minus|➡️ arrow_right next|⬅️ arrow_left back|⬆️ arrow_up up|⬇️ arrow_down down|" +
      "↩️ leftwards_arrow_with_hook undo revert|🔁 repeat retry loop|🔄 arrows_counterclockwise refresh sync|🆗 ok|🆕 new|🔜 soon|🆘 sos help|" +
      "✨ sparkles new shiny magic|⭐ star favorite|⚡ zap lightning fast|🔥 fire hot lit|💥 boom collision|💤 zzz sleep|" +
      "💬 speech_balloon comment chat|💭 thought_balloon thinking|🔴 red_circle|🟠 orange_circle|🟡 yellow_circle|🟢 green_circle go|🔵 large_blue_circle|🟣 purple_circle|" +
      "🔔 bell notification|🔕 no_bell mute|🎵 musical_note music|" +
      "🏁 checkered_flag finish done|🚩 triangular_flag_on_post red_flag|1️⃣ one|2️⃣ two|3️⃣ three",
  ],
  [
    "Objects & work",
    "💼",
    "🚀 rocket launch ship deploy|🚢 ship boat|🎉 tada party celebrate hooray|🎁 gift present|🏆 trophy win|🏅 medal|" +
      "🎯 dart target bullseye|🎮 video_game|🧩 jigsaw puzzle|💼 briefcase work|💻 computer laptop|⌨️ keyboard|" +
      "📱 iphone phone mobile|🔌 electric_plug plugin|💡 bulb idea|🔧 wrench fix tool|🔨 hammer build|" +
      "🛠️ hammer_and_wrench tools build|⚙️ gear settings config|🧰 toolbox|🧪 test_tube test experiment|🔬 microscope|" +
      "🔒 lock secure private|🔓 unlock|🔑 key|🛡️ shield security|🐛 bug|📌 pushpin pin|📎 paperclip attach|" +
      "✂️ scissors cut|📝 memo note write|✏️ pencil2 edit|📄 page_facing_up doc|📊 bar_chart stats|📈 chart_with_upwards_trend up growth|" +
      "📉 chart_with_downwards_trend down|📁 file_folder folder|🗑️ wastebasket trash delete|📋 clipboard|" +
      "📅 date calendar|⏰ alarm_clock|⏱️ stopwatch timer|⏳ hourglass_flowing_sand hourglass wait|⌛ hourglass_done|📦 package box ship release|" +
      "✉️ envelope email mail|📢 loudspeaker announce|📣 mega megaphone|🔇 mute|🎤 microphone|🎧 headphones|" +
      "📷 camera photo|🔍 mag search find|📚 books docs|📖 book read|🏷️ label tag|💰 moneybag money|" +
      "🏗️ building_construction wip|🚧 construction wip|🚨 rotating_light alert incident|" +
      "🧹 broom cleanup|🩹 adhesive_bandage patch fix|🔮 crystal_ball|🪄 magic_wand|🎨 art design|" +
      "🎓 mortar_board graduate learn|👑 crown king|💎 gem diamond|✈️ airplane travel|🏠 house home|🏢 office|🏖️ beach_with_umbrella vacation|" +
      "🧭 compass",
  ],
  [
    "Nature & food",
    "🌿",
    "🌱 seedling growth|🍀 four_leaf_clover luck|🌳 deciduous_tree tree|🍂 fallen_leaf autumn|" +
      "🌸 cherry_blossom flower|🌻 sunflower|💐 bouquet flowers|🌈 rainbow|☀️ sunny sun|☁️ cloud|🌧️ rain|" +
      "❄️ snowflake cold|🌊 ocean wave|💧 droplet water|🌙 crescent_moon night|🌍 earth_africa world globe|" +
      "🐶 dog|🐱 cat|🦊 fox_face fox|🦁 lion|🐸 frog|🐧 penguin|" +
      "🦉 owl|🦄 unicorn|🐝 bee busy|🦋 butterfly|🐢 turtle slow|🐍 snake python|🦀 crab rust|🐳 whale docker|" +
      "🐌 snail slow|🦖 t-rex dinosaur|🍎 apple|" +
      "🍓 strawberry|🥑 avocado|🌶️ hot_pepper spicy|" +
      "🍳 fried_egg cooking|🍔 hamburger burger|🍟 fries|🍕 pizza|" +
      "🌮 taco|🍜 ramen noodles|🍣 sushi|🍩 doughnut donut|🍪 cookie|🎂 birthday cake|🍰 cake|" +
      "🧁 cupcake|🍿 popcorn|☕ coffee|🍵 tea|🧋 bubble_tea boba|🍺 beer|🍻 beers cheers|🥂 clinking_glasses cheers toast|" +
      "🍷 wine_glass wine|🍾 champagne celebrate",
  ],
  [
    "Flags",
    "🏳️",
    "🏳️ white_flag surrender|🏴‍☠️ pirate_flag|🏳️‍🌈 rainbow_flag pride|🇺🇸 us usa america|🇬🇧 gb uk britain|🇨🇦 canada|🇮🇳 india|🇩🇪 germany|🇫🇷 france|" +
      "🇯🇵 japan|🇪🇸 spain|🇮🇹 italy|🇧🇷 brazil|🇲🇽 mexico|🇦🇺 australia|🇰🇷 korea|🇨🇳 china|🇪🇺 eu europe",
  ],
];
