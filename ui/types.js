/*
 * Media types for the collection.
 *
 * To add a new type (board games, manga, cassettes…), copy one of the blocks
 * below, give it a new key, and pick a `shape` for how it looks on the shelf:
 *   book  – varied spines, width follows page count
 *   vinyl – thin record sleeves
 *   cd    – jewel cases
 *   game  – game cases, coloured by platform
 *   disc  – movie cases (Blu-ray / DVD / 4K)
 *
 * Each field is free text unless it has `options` (a fixed dropdown) or
 * `type: 'number'`. `presets` are suggestions only; you can always type your
 * own value, and anything you've typed before is suggested again next time.
 */
// Music genres are shared by vinyl and CDs.
const MUSIC_GENRES = [
  // rock & alternative
  'Rock', 'Classic rock', 'Hard rock', 'Alternative', 'Indie', 'Indie rock', 'Punk', 'Post-punk', 'Grunge', 'Emo',
  'Shoegaze', 'Psychedelic', 'Progressive rock', 'Post-rock', 'Math rock', 'Britpop',
  // metal
  'Metal', 'Heavy metal', 'Thrash metal', 'Death metal', 'Black metal', 'Doom metal', 'Metalcore', 'Nu metal',
  // pop
  'Pop', 'Synth-pop', 'Dream pop', 'Indie pop', 'Art pop', 'K-pop', 'J-pop', 'C-pop', 'Mandopop', 'Cantopop',
  'City pop', 'Malay pop', 'Anime', 'Vocaloid', 'Idol',
  // hip-hop, R&B & soul
  'Hip-hop', 'Rap', 'Trap', 'Boom bap', 'R&B', 'Neo-soul', 'Soul', 'Funk', 'Disco', 'Gospel', 'Motown',
  // electronic
  'Electronic', 'House', 'Techno', 'Trance', 'Drum and bass', 'Dubstep', 'Ambient', 'IDM', 'Synthwave',
  'Vaporwave', 'Lo-fi', 'Downtempo', 'Trip-hop', 'Chiptune', 'Hyperpop', 'EDM',
  // jazz, blues & classical
  'Jazz', 'Bebop', 'Jazz fusion', 'Smooth jazz', 'Blues', 'Classical', 'Baroque', 'Opera', 'Orchestral',
  'Chamber', 'Contemporary classical', 'Piano',
  // roots & world
  'Folk', 'Singer-songwriter', 'Country', 'Americana', 'Bluegrass', 'Reggae', 'Ska', 'Dub', 'Latin', 'Bossa nova',
  'Afrobeat', 'Afrobeats', 'World', 'Celtic',
  // soundtracks & other
  'Soundtrack', 'Film score', 'Video game music', 'Musical', 'Spoken word', 'Comedy', 'Children\'s', 'Christmas',
  'Experimental', 'Noise', 'New age',
];

window.CT = {
  STATUSES: ['Owned', 'Wishlist', 'Lent out', 'Sold'],
  CONDITIONS: ['Sealed', 'Mint', 'Near mint', 'Very good', 'Good', 'Fair', 'Poor'],

  TYPES: {
    book: {
      label: 'Books', singular: 'Book', icon: '📚', creator: 'Author', shape: 'book',
      genres: [
        // fiction
        'Fiction', 'Literary fiction', 'Classics', 'Contemporary', 'Historical fiction', 'Fantasy', 'Epic fantasy',
        'Urban fantasy', 'Science fiction', 'Cyberpunk', 'Space opera', 'Dystopian', 'Post-apocalyptic', 'Mystery',
        'Crime', 'Detective', 'Cozy mystery', 'Thriller', 'Psychological thriller', 'Spy', 'Horror', 'Gothic',
        'Romance', 'Romantasy', 'Adventure', 'Magical realism', 'Short stories', 'Young adult', 'Middle grade',
        "Children's", 'Picture book', 'Light novel', 'Web novel', 'Humour', 'Satire', 'Western', 'War',
        // comics
        'Manga', 'Manhwa', 'Manhua', 'Comics', 'Graphic novel',
        // non-fiction
        'Non-fiction', 'Biography', 'Memoir', 'Autobiography', 'History', 'Military history', 'Science', 'Popular science',
        'Nature', 'Technology', 'Computing', 'Programming', 'Mathematics', 'Philosophy', 'Psychology', 'Religion',
        'Spirituality', 'Politics', 'Economics', 'Business', 'Finance', 'Self-help', 'Productivity', 'Health',
        'Fitness', 'Cookbook', 'Food & drink', 'Travel', 'Art', 'Design', 'Photography', 'Architecture', 'Music',
        'Film & TV', 'Gaming', 'Sports', 'True crime', 'Essays', 'Journalism', 'Language', 'Education', 'Reference',
        'Parenting', 'Crafts & hobbies',
        // other
        'Poetry', 'Drama', 'Anthology', 'Art book',
      ],
      fields: [
        { key: 'format', label: 'Format', presets: ['Hardcover', 'Paperback', 'Mass market', 'Box set', 'Omnibus'] },
        { key: 'pages', label: 'Pages', type: 'number' },
        { key: 'publisher', label: 'Publisher' },
        { key: 'series', label: 'Series' },
        { key: 'isbn', label: 'ISBN' },
        { key: 'edition', label: 'Edition', presets: ['First edition', 'Signed', 'Special edition'] },
      ],
    },

    vinyl: {
      label: 'Vinyl', singular: 'Record', icon: '🎵', creator: 'Artist', shape: 'vinyl',
      genres: MUSIC_GENRES,
      fields: [
        { key: 'format', label: 'Format', presets: ['12" LP', '2×LP', '3×LP', '10"', '7" single', 'Box set'] },
        { key: 'speed', label: 'Speed', presets: ['33⅓ RPM', '45 RPM', '78 RPM'] },
        { key: 'variant', label: 'Vinyl colour / variant', presets: ['Black', 'Coloured', 'Clear', 'Splatter', 'Picture disc', 'Marbled'] },
        { key: 'label', label: 'Label' },
        { key: 'catalogNo', label: 'Catalogue no.' },
        { key: 'country', label: 'Pressing country' },
      ],
    },

    cd: {
      label: 'CDs', singular: 'CD', icon: '💿', creator: 'Artist', shape: 'cd',
      genres: MUSIC_GENRES,
      fields: [
        { key: 'format', label: 'Format', presets: ['CD', '2×CD', 'CD single', 'CD + DVD', 'SACD', 'Box set'] },
        { key: 'edition', label: 'Edition', presets: ['Standard', 'Deluxe', 'Limited', 'Remastered', 'Japanese import'] },
        { key: 'label', label: 'Label' },
        { key: 'catalogNo', label: 'Catalogue no.' },
        { key: 'country', label: 'Country' },
      ],
    },

    game: {
      label: 'Games', singular: 'Game', icon: '🎮', creator: 'Developer', shape: 'game',
      genres: [
        // action
        'Action', 'Action-adventure', 'Hack and slash', 'Character action', 'Beat \'em up', 'Stealth', 'Soulslike',
        'Survival', 'Survival horror', 'Horror', 'Psychological horror',
        // RPG
        'RPG', 'Action RPG', 'JRPG', 'CRPG', 'Tactical RPG', 'MMORPG', 'Dungeon crawler', 'Monster taming',
        // shooters
        'Shooter', 'FPS', 'Third-person shooter', 'Hero shooter', 'Battle royale', 'Looter shooter', 'Shoot \'em up',
        'Bullet hell', 'Rail shooter',
        // platformers & adventure
        'Platformer', '3D platformer', 'Metroidvania', 'Roguelike', 'Roguelite', 'Adventure', 'Point-and-click',
        'Visual novel', 'Narrative', 'Walking sim', 'Open world', 'Sandbox', 'Immersive sim',
        // strategy & sim
        'Strategy', 'Real-time strategy', 'Turn-based strategy', '4X', 'Grand strategy', 'Tower defense', 'Card game',
        'Deckbuilder', 'Auto battler', 'Simulation', 'Life sim', 'Farming sim', 'City builder', 'Management',
        'Flight sim', 'Vehicle sim',
        // competitive & arcade
        'Fighting', 'Arena fighter', 'Platform fighter', 'Racing', 'Kart racing', 'Sim racing', 'Sports', 'Football',
        'Basketball', 'Wrestling', 'Golf', 'Skateboarding', 'Puzzle', 'Rhythm', 'Music', 'Party', 'Arcade',
        'Pinball', 'Trivia', 'MOBA',
        // other
        'Educational', 'Fitness', 'VR', 'Compilation', 'Indie',
      ],
      fields: [
        { key: 'platform', label: 'Platform', presets: ['PS5', 'PS4', 'PS3', 'PS2', 'PS1', 'PS Vita', 'PSP',
          'Switch 2', 'Switch', 'Wii U', 'Wii', 'GameCube', 'N64', 'SNES', '3DS', 'DS', 'Game Boy Advance', 'Game Boy',
          'Xbox Series X', 'Xbox One', 'Xbox 360', 'Xbox', 'PC', 'Dreamcast', 'Sega Saturn', 'Mega Drive'] },
        { key: 'region', label: 'Region', presets: ['NTSC-U (US)', 'PAL (EU/UK)', 'NTSC-J (Japan)', 'Asia', 'Region free'] },
        { key: 'edition', label: 'Edition', presets: ['Standard', "Collector's", 'Deluxe', 'Limited Run', 'Greatest Hits', 'Steelbook'] },
        { key: 'completeness', label: 'Contents', presets: ['Complete in box', 'Game + case', 'Loose cartridge/disc', 'Manual missing'] },
        { key: 'progress', label: 'Progress', options: ['Unplayed', 'Playing', 'Beaten', '100%', 'On hold', 'Abandoned'] },
      ],
    },

    bluray: {
      label: 'Blu-rays', singular: 'Movie', icon: '🎬', creator: 'Director', shape: 'disc',
      genres: [
        'Action', 'Martial arts', 'Superhero', 'Adventure', 'Animation', 'Anime', 'Stop motion', 'Comedy',
        'Romantic comedy', 'Dark comedy', 'Parody', 'Drama', 'Period drama', 'Coming-of-age', 'Biopic', 'Sports',
        'Romance', 'Horror', 'Slasher', 'Supernatural horror', 'Folk horror', 'Found footage', 'Zombie', 'Sci-fi',
        'Cyberpunk', 'Space', 'Fantasy', 'Thriller', 'Psychological thriller', 'Mystery', 'Neo-noir', 'Film noir',
        'Crime', 'Gangster', 'Heist', 'Spy', 'War', 'Western', 'Disaster', 'Kaiju', 'Monster', 'Musical',
        'Music', 'Concert', 'Dance', 'Family', "Children's", 'Documentary', 'Nature documentary', 'Mockumentary',
        'Experimental', 'Arthouse', 'Silent', 'Classic', 'Cult', 'Asian cinema', 'K-drama', 'Bollywood', 'Wuxia',
        'Hong Kong action', 'Tokusatsu', 'TV series', 'Miniseries', 'Stand-up',
      ],
      fields: [
        { key: 'format', label: 'Format', presets: ['Blu-ray', '4K UHD', '4K UHD + Blu-ray', '3D Blu-ray', 'DVD'] },
        { key: 'region', label: 'Region', presets: ['A', 'B', 'C', 'Region free', 'DVD R1', 'DVD R2', 'DVD R3', 'DVD R4'] },
        { key: 'edition', label: 'Edition', presets: ['Standard', 'Steelbook', "Collector's", 'Criterion', 'Limited', 'Box set'] },
        { key: 'studio', label: 'Studio / distributor' },
        { key: 'runtime', label: 'Runtime (min)', type: 'number' },
        { key: 'discs', label: 'Discs', type: 'number' },
      ],
    },
  },
};
