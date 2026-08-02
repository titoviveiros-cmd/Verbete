export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  public: {
    Tables: {
      achievements: {
        Row: {
          code: string;
          created_at: string;
          description: string;
          emoji: string;
          id: string;
          name: string;
          rarity: string;
        };
        Insert: {
          code: string;
          created_at?: string;
          description: string;
          emoji?: string;
          id?: string;
          name: string;
          rarity?: string;
        };
        Update: {
          code?: string;
          created_at?: string;
          description?: string;
          emoji?: string;
          id?: string;
          name?: string;
          rarity?: string;
        };
        Relationships: [];
      };
      ai_served_defs: {
        Row: {
          created_at: string;
          norm_text: string;
          room_id: string;
          round: number;
        };
        Insert: {
          created_at?: string;
          norm_text: string;
          room_id: string;
          round: number;
        };
        Update: {
          created_at?: string;
          norm_text?: string;
          room_id?: string;
          round?: number;
        };
        Relationships: [
          {
            foreignKeyName: "ai_served_defs_room_id_fkey";
            columns: ["room_id"];
            isOneToOne: false;
            referencedRelation: "rooms";
            referencedColumns: ["id"];
          },
        ];
      };
      app_config: {
        Row: {
          key: string;
          updated_at: string;
          value: string;
        };
        Insert: {
          key: string;
          updated_at?: string;
          value: string;
        };
        Update: {
          key?: string;
          updated_at?: string;
          value?: string;
        };
        Relationships: [];
      };
      banned_players: {
        Row: {
          banned_at: string;
          banned_by: string;
          expires_at: string | null;
          id: string;
          player_id: string | null;
          reason: string;
          user_id: string | null;
        };
        Insert: {
          banned_at?: string;
          banned_by: string;
          expires_at?: string | null;
          id?: string;
          player_id?: string | null;
          reason?: string;
          user_id?: string | null;
        };
        Update: {
          banned_at?: string;
          banned_by?: string;
          expires_at?: string | null;
          id?: string;
          player_id?: string | null;
          reason?: string;
          user_id?: string | null;
        };
        Relationships: [];
      };
      daily_attempts: {
        Row: {
          challenge_date: string | null;
          challenge_hour: string;
          created_at: string;
          guess: string;
          id: string;
          is_correct: boolean;
          score: number;
          similarity: number;
          time_seconds: number;
          user_id: string;
        };
        Insert: {
          challenge_date?: string | null;
          challenge_hour?: string;
          created_at?: string;
          guess: string;
          id?: string;
          is_correct?: boolean;
          score?: number;
          similarity?: number;
          time_seconds?: number;
          user_id: string;
        };
        Update: {
          challenge_date?: string | null;
          challenge_hour?: string;
          created_at?: string;
          guess?: string;
          id?: string;
          is_correct?: boolean;
          score?: number;
          similarity?: number;
          time_seconds?: number;
          user_id?: string;
        };
        Relationships: [];
      };
      daily_challenges: {
        Row: {
          challenge_date: string | null;
          challenge_hour: string;
          created_at: string;
          id: string;
          word_id: string;
        };
        Insert: {
          challenge_date?: string | null;
          challenge_hour?: string;
          created_at?: string;
          id?: string;
          word_id: string;
        };
        Update: {
          challenge_date?: string | null;
          challenge_hour?: string;
          created_at?: string;
          id?: string;
          word_id?: string;
        };
        Relationships: [];
      };
      definitions: {
        Row: {
          created_at: string;
          id: string;
          is_truth: boolean;
          letter: string | null;
          near_truth: boolean;
          player_id: string;
          room_id: string;
          round: number;
          text: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          is_truth?: boolean;
          letter?: string | null;
          near_truth?: boolean;
          player_id: string;
          room_id: string;
          round: number;
          text: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          is_truth?: boolean;
          letter?: string | null;
          near_truth?: boolean;
          player_id?: string;
          room_id?: string;
          round?: number;
          text?: string;
        };
        Relationships: [
          {
            foreignKeyName: "definitions_room_id_fkey";
            columns: ["room_id"];
            isOneToOne: false;
            referencedRelation: "rooms";
            referencedColumns: ["id"];
          },
        ];
      };
      match_history: {
        Row: {
          final_score: number;
          id: string;
          played_at: string;
          players_count: number;
          position: number;
          room_code: string;
          user_id: string;
        };
        Insert: {
          final_score: number;
          id?: string;
          played_at?: string;
          players_count: number;
          position: number;
          room_code: string;
          user_id: string;
        };
        Update: {
          final_score?: number;
          id?: string;
          played_at?: string;
          players_count?: number;
          position?: number;
          room_code?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      ops_events: {
        Row: {
          at: string;
          build: string | null;
          id: number;
          kind: string;
          payload: Json;
          room_hash: string | null;
          session_key: string | null;
        };
        Insert: {
          at?: string;
          build?: string | null;
          id?: never;
          kind: string;
          payload?: Json;
          room_hash?: string | null;
          session_key?: string | null;
        };
        Update: {
          at?: string;
          build?: string | null;
          id?: never;
          kind?: string;
          payload?: Json;
          room_hash?: string | null;
          session_key?: string | null;
        };
        Relationships: [];
      };
      players: {
        Row: {
          avatar: string;
          color: string;
          coordinator_count: number;
          id: string;
          is_bot: boolean;
          is_connected: boolean;
          joined_at: string;
          kicked_at: string | null;
          nickname: string;
          room_id: string;
          score: number;
          team_id: string | null;
          user_id: string | null;
          voting_extensions: number;
          writing_extensions: number;
        };
        Insert: {
          avatar?: string;
          color?: string;
          coordinator_count?: number;
          id: string;
          is_bot?: boolean;
          is_connected?: boolean;
          joined_at?: string;
          kicked_at?: string | null;
          nickname: string;
          room_id: string;
          score?: number;
          team_id?: string | null;
          user_id?: string | null;
          voting_extensions?: number;
          writing_extensions?: number;
        };
        Update: {
          avatar?: string;
          color?: string;
          coordinator_count?: number;
          id?: string;
          is_bot?: boolean;
          is_connected?: boolean;
          joined_at?: string;
          kicked_at?: string | null;
          nickname?: string;
          room_id?: string;
          score?: number;
          team_id?: string | null;
          user_id?: string | null;
          voting_extensions?: number;
          writing_extensions?: number;
        };
        Relationships: [
          {
            foreignKeyName: "players_room_id_fkey";
            columns: ["room_id"];
            isOneToOne: false;
            referencedRelation: "rooms";
            referencedColumns: ["id"];
          },
        ];
      };
      profiles: {
        Row: {
          avatar: string;
          color: string;
          created_at: string;
          display_name: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          avatar?: string;
          color?: string;
          created_at?: string;
          display_name?: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          avatar?: string;
          color?: string;
          created_at?: string;
          display_name?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      reactions: {
        Row: {
          created_at: string;
          emoji: string;
          id: string;
          player_id: string;
          room_id: string;
        };
        Insert: {
          created_at?: string;
          emoji: string;
          id?: string;
          player_id: string;
          room_id: string;
        };
        Update: {
          created_at?: string;
          emoji?: string;
          id?: string;
          player_id?: string;
          room_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "reactions_room_id_fkey";
            columns: ["room_id"];
            isOneToOne: false;
            referencedRelation: "rooms";
            referencedColumns: ["id"];
          },
        ];
      };
      reports: {
        Row: {
          created_at: string;
          definition_id: string | null;
          definition_text: string;
          id: string;
          offender_nickname: string | null;
          offender_player_id: string;
          offender_user_id: string | null;
          reason: string;
          reporter_user_id: string;
          resolution_note: string | null;
          resolved_at: string | null;
          resolved_by: string | null;
          room_code: string | null;
          room_id: string | null;
          round: number | null;
          status: string;
        };
        Insert: {
          created_at?: string;
          definition_id?: string | null;
          definition_text: string;
          id?: string;
          offender_nickname?: string | null;
          offender_player_id: string;
          offender_user_id?: string | null;
          reason?: string;
          reporter_user_id: string;
          resolution_note?: string | null;
          resolved_at?: string | null;
          resolved_by?: string | null;
          room_code?: string | null;
          room_id?: string | null;
          round?: number | null;
          status?: string;
        };
        Update: {
          created_at?: string;
          definition_id?: string | null;
          definition_text?: string;
          id?: string;
          offender_nickname?: string | null;
          offender_player_id?: string;
          offender_user_id?: string | null;
          reason?: string;
          reporter_user_id?: string;
          resolution_note?: string | null;
          resolved_at?: string | null;
          resolved_by?: string | null;
          room_code?: string | null;
          room_id?: string | null;
          round?: number | null;
          status?: string;
        };
        Relationships: [];
      };
      room_messages: {
        Row: {
          created_at: string;
          id: string;
          player_id: string;
          room_id: string;
          text: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          player_id: string;
          room_id: string;
          text: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          player_id?: string;
          room_id?: string;
          text?: string;
        };
        Relationships: [
          {
            foreignKeyName: "room_messages_room_id_fkey";
            columns: ["room_id"];
            isOneToOne: false;
            referencedRelation: "rooms";
            referencedColumns: ["id"];
          },
        ];
      };
      room_words: {
        Row: {
          category: string;
          created_at: string;
          created_by: string | null;
          id: string;
          meaning: string;
          room_id: string;
          word: string;
        };
        Insert: {
          category?: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          meaning: string;
          room_id: string;
          word: string;
        };
        Update: {
          category?: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          meaning?: string;
          room_id?: string;
          word?: string;
        };
        Relationships: [];
      };
      rooms: {
        Row: {
          categories: string[];
          code: string;
          created_at: string;
          current_coordinator: string | null;
          current_round: number;
          current_word_id: string | null;
          host_id: string;
          id: string;
          mode: string;
          nivel: string;
          phase_started_at: string | null;
          round_phase_ends_at: string | null;
          status: string;
          teams: Json;
          used_word_ids: string[];
          visibility: string;
          win_condition: string;
          win_target: number;
        };
        Insert: {
          categories?: string[];
          code: string;
          created_at?: string;
          current_coordinator?: string | null;
          current_round?: number;
          current_word_id?: string | null;
          host_id: string;
          id?: string;
          mode?: string;
          nivel?: string;
          phase_started_at?: string | null;
          round_phase_ends_at?: string | null;
          status?: string;
          teams?: Json;
          used_word_ids?: string[];
          visibility?: string;
          win_condition?: string;
          win_target?: number;
        };
        Update: {
          categories?: string[];
          code?: string;
          created_at?: string;
          current_coordinator?: string | null;
          current_round?: number;
          current_word_id?: string | null;
          host_id?: string;
          id?: string;
          mode?: string;
          nivel?: string;
          phase_started_at?: string | null;
          round_phase_ends_at?: string | null;
          status?: string;
          teams?: Json;
          used_word_ids?: string[];
          visibility?: string;
          win_condition?: string;
          win_target?: number;
        };
        Relationships: [
          {
            foreignKeyName: "rooms_current_word_id_fkey";
            columns: ["current_word_id"];
            isOneToOne: false;
            referencedRelation: "words";
            referencedColumns: ["id"];
          },
        ];
      };
      round_extensions: {
        Row: {
          applied_at: string;
          attempt: number;
          id: string;
          phase: string;
          player_id: string;
          room_id: string;
          round: number;
        };
        Insert: {
          applied_at?: string;
          attempt: number;
          id?: string;
          phase?: string;
          player_id: string;
          room_id: string;
          round: number;
        };
        Update: {
          applied_at?: string;
          attempt?: number;
          id?: string;
          phase?: string;
          player_id?: string;
          room_id?: string;
          round?: number;
        };
        Relationships: [];
      };
      rounds: {
        Row: {
          coordinator_id: string;
          id: string;
          room_id: string;
          round: number;
          scored_at: string;
          word_id: string | null;
        };
        Insert: {
          coordinator_id: string;
          id?: string;
          room_id: string;
          round: number;
          scored_at?: string;
          word_id?: string | null;
        };
        Update: {
          coordinator_id?: string;
          id?: string;
          room_id?: string;
          round?: number;
          scored_at?: string;
          word_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "rounds_room_id_fkey";
            columns: ["room_id"];
            isOneToOne: false;
            referencedRelation: "rooms";
            referencedColumns: ["id"];
          },
        ];
      };
      user_achievements: {
        Row: {
          achievement_code: string;
          id: string;
          unlocked_at: string;
          user_id: string;
        };
        Insert: {
          achievement_code: string;
          id?: string;
          unlocked_at?: string;
          user_id: string;
        };
        Update: {
          achievement_code?: string;
          id?: string;
          unlocked_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      user_roles: {
        Row: {
          created_at: string;
          id: string;
          role: Database["public"]["Enums"]["app_role"];
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          role: Database["public"]["Enums"]["app_role"];
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          role?: Database["public"]["Enums"]["app_role"];
          user_id?: string;
        };
        Relationships: [];
      };
      user_stats: {
        Row: {
          best_match_score: number;
          best_streak: number;
          best_win_streak: number;
          current_streak: number;
          games_played: number;
          games_won: number;
          last_played_date: string | null;
          last_played_hour: string | null;
          level: number;
          rounds_coordinated: number;
          total_fooled: number;
          total_score: number;
          total_truth_hits: number;
          updated_at: string;
          user_id: string;
          win_streak: number;
          xp: number;
        };
        Insert: {
          best_match_score?: number;
          best_streak?: number;
          best_win_streak?: number;
          current_streak?: number;
          games_played?: number;
          games_won?: number;
          last_played_date?: string | null;
          last_played_hour?: string | null;
          level?: number;
          rounds_coordinated?: number;
          total_fooled?: number;
          total_score?: number;
          total_truth_hits?: number;
          updated_at?: string;
          user_id: string;
          win_streak?: number;
          xp?: number;
        };
        Update: {
          best_match_score?: number;
          best_streak?: number;
          best_win_streak?: number;
          current_streak?: number;
          games_played?: number;
          games_won?: number;
          last_played_date?: string | null;
          last_played_hour?: string | null;
          level?: number;
          rounds_coordinated?: number;
          total_fooled?: number;
          total_score?: number;
          total_truth_hits?: number;
          updated_at?: string;
          user_id?: string;
          win_streak?: number;
          xp?: number;
        };
        Relationships: [];
      };
      votes: {
        Row: {
          created_at: string;
          definition_id: string;
          id: string;
          room_id: string;
          round: number;
          voter_id: string;
        };
        Insert: {
          created_at?: string;
          definition_id: string;
          id?: string;
          room_id: string;
          round: number;
          voter_id: string;
        };
        Update: {
          created_at?: string;
          definition_id?: string;
          id?: string;
          room_id?: string;
          round?: number;
          voter_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "votes_definition_id_fkey";
            columns: ["definition_id"];
            isOneToOne: false;
            referencedRelation: "definitions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "votes_room_id_fkey";
            columns: ["room_id"];
            isOneToOne: false;
            referencedRelation: "rooms";
            referencedColumns: ["id"];
          },
        ];
      };
      words: {
        Row: {
          category: string | null;
          classe: string | null;
          created_at: string;
          curiosidade: string | null;
          exemplo: string | null;
          id: string;
          meaning: string;
          nivel: string;
          origem: string | null;
          pronuncia: string | null;
          rarity: number;
          review_notes: string | null;
          sinonimos: string[];
          status: string;
          word: string;
        };
        Insert: {
          category?: string | null;
          classe?: string | null;
          created_at?: string;
          curiosidade?: string | null;
          exemplo?: string | null;
          id?: string;
          meaning: string;
          nivel?: string;
          origem?: string | null;
          pronuncia?: string | null;
          rarity?: number;
          review_notes?: string | null;
          sinonimos?: string[];
          status?: string;
          word: string;
        };
        Update: {
          category?: string | null;
          classe?: string | null;
          created_at?: string;
          curiosidade?: string | null;
          exemplo?: string | null;
          id?: string;
          meaning?: string;
          nivel?: string;
          origem?: string | null;
          pronuncia?: string | null;
          rarity?: number;
          review_notes?: string | null;
          sinonimos?: string[];
          status?: string;
          word?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      admin_list_words: {
        Args: { p_limit?: number; p_offset?: number; p_status?: string };
        Returns: Json;
      };
      admin_ops_recent: {
        Args: { p_limit?: number };
        Returns: {
          at: string;
          build: string | null;
          id: number;
          kind: string;
          payload: Json;
          room_hash: string | null;
          session_key: string | null;
        }[];
        SetofOptions: {
          from: "*";
          to: "ops_events";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      admin_ops_summary: { Args: { p_hours?: number }; Returns: Json };
      admin_review_word: {
        Args: {
          p_action: string;
          p_meaning?: string;
          p_notes?: string;
          p_word_id: string;
        };
        Returns: Json;
      };
      advance_choosing_to_writing: {
        Args: { p_room_id: string };
        Returns: Json;
      };
      advance_reveal_to_scoreboard: {
        Args: { p_room_id: string };
        Returns: undefined;
      };
      advance_scoreboard_to_next_round_or_finished: {
        Args: { p_force?: boolean; p_room_id: string };
        Returns: Json;
      };
      advance_voting_to_reveal: {
        Args: { p_room_id: string };
        Returns: undefined;
      };
      advance_writing_to_voting: {
        Args: { p_room_id: string };
        Returns: undefined;
      };
      apply_similarity_bonus:
        | { Args: { p_definition_ids: string[] }; Returns: Json }
        | {
            Args: {
              p_definition_ids: string[];
              p_room_id: string;
              p_round: number;
            };
            Returns: Json;
          };
      assert_actor_identity: {
        Args: { p_actor_id: string; p_room_id: string };
        Returns: string;
      };
      assign_player_team: {
        Args: {
          p_actor_id: string;
          p_player_id: string;
          p_room_id: string;
          p_team_id: string;
        };
        Returns: Json;
      };
      cast_vote: {
        Args: {
          p_definition_id: string;
          p_room_id: string;
          p_voter_id: string;
        };
        Returns: Json;
      };
      cast_votes_bulk: {
        Args: { p_room_id: string; p_round: number; p_votes: Json };
        Returns: Json;
      };
      choose_word: {
        Args: { p_duration_sec?: number; p_room_id: string; p_word_id: string };
        Returns: Json;
      };
      claim_player_identity: { Args: { p_player_id: string }; Returns: Json };
      cleanup_zombie_rooms: { Args: never; Returns: Json };
      create_room_with_host: {
        Args: {
          p_avatar: string;
          p_color: string;
          p_host_id: string;
          p_nickname: string;
        };
        Returns: {
          categories: string[];
          code: string;
          created_at: string;
          current_coordinator: string | null;
          current_round: number;
          current_word_id: string | null;
          host_id: string;
          id: string;
          mode: string;
          nivel: string;
          phase_started_at: string | null;
          round_phase_ends_at: string | null;
          status: string;
          teams: Json;
          used_word_ids: string[];
          visibility: string;
          win_condition: string;
          win_target: number;
        };
        SetofOptions: {
          from: "*";
          to: "rooms";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      extend_voting_or_advance: { Args: { p_room_id: string }; Returns: Json };
      extend_writing_or_advance: { Args: { p_room_id: string }; Returns: Json };
      finish_reveal: { Args: { p_room_id: string }; Returns: Json };
      get_app_config: { Args: { p_key: string }; Returns: string };
      get_ballot: { Args: { p_room_id: string }; Returns: Json };
      get_daily_leaderboard: {
        Args: { p_limit?: number };
        Returns: {
          is_correct: boolean;
          score: number;
          time_seconds: number;
          user_id: string;
        }[];
      };
      get_my_daily_review: { Args: never; Returns: Json };
      get_or_create_daily_challenge: {
        Args: { p_date?: string };
        Returns: Json;
      };
      get_random_word_prompts: {
        Args: {
          exclude_ids?: string[];
          lim?: number;
          min_rarity?: number;
          p_categories?: string[];
          p_nivel?: string;
        };
        Returns: {
          category: string;
          classe: string;
          id: string;
          nivel: string;
          pronuncia: string;
          rarity: number;
          word: string;
        }[];
      };
      get_random_words: {
        Args: {
          exclude_ids?: string[];
          lim?: number;
          min_rarity?: number;
          p_categories?: string[];
          p_nivel?: string;
        };
        Returns: {
          category: string | null;
          classe: string | null;
          created_at: string;
          curiosidade: string | null;
          exemplo: string | null;
          id: string;
          meaning: string;
          nivel: string;
          origem: string | null;
          pronuncia: string | null;
          rarity: number;
          review_notes: string | null;
          sinonimos: string[];
          status: string;
          word: string;
        }[];
        SetofOptions: {
          from: "*";
          to: "words";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      get_ranking_top: {
        Args: { p_limit?: number };
        Returns: {
          avatar: string;
          best_match_score: number;
          color: string;
          display_name: string;
          games_played: number;
          games_won: number;
          total_score: number;
          user_id: string;
        }[];
      };
      get_room_definitions: { Args: { p_room_id: string }; Returns: Json };
      get_room_reveal: { Args: { p_room_id: string }; Returns: Json };
      get_room_state: { Args: { p_code: string }; Returns: Json };
      get_round_reveal: {
        Args: { p_room_id: string; p_round: number };
        Returns: Json;
      };
      get_round_sync: { Args: { p_room_id: string }; Returns: Json };
      get_word_reveal: { Args: { p_room_id: string }; Returns: Json };
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"];
          _user_id: string;
        };
        Returns: boolean;
      };
      host_update_room_config: {
        Args: { p_actor_id: string; p_patch: Json; p_room_id: string };
        Returns: Json;
      };
      insert_truth_definition: {
        Args: { p_room_id: string; p_round: number; p_text: string };
        Returns: Json;
      };
      is_player_banned: {
        Args: { _player_id: string; _user_id: string };
        Returns: boolean;
      };
      join_public_room: {
        Args: {
          p_avatar: string;
          p_color: string;
          p_nickname: string;
          p_player_id: string;
        };
        Returns: {
          categories: string[];
          code: string;
          created_at: string;
          current_coordinator: string | null;
          current_round: number;
          current_word_id: string | null;
          host_id: string;
          id: string;
          mode: string;
          nivel: string;
          phase_started_at: string | null;
          round_phase_ends_at: string | null;
          status: string;
          teams: Json;
          used_word_ids: string[];
          visibility: string;
          win_condition: string;
          win_target: number;
        };
        SetofOptions: {
          from: "*";
          to: "rooms";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      kick_player: {
        Args: {
          p_actor_id: string;
          p_room_id: string;
          p_target_player_id: string;
        };
        Returns: Json;
      };
      leave_room: { Args: { p_player_id: string }; Returns: Json };
      log_ops_event: {
        Args: {
          p_build?: string;
          p_kind: string;
          p_payload?: Json;
          p_room_hash?: string;
          p_session_key?: string;
        };
        Returns: undefined;
      };
      phase_secs: {
        Args: { p_base: number; p_room_id: string };
        Returns: number;
      };
      record_match_result: { Args: { p_room_code: string }; Returns: Json };
      rejoin_room: {
        Args: {
          p_avatar: string;
          p_code: string;
          p_color: string;
          p_nickname: string;
          p_player_id: string;
        };
        Returns: Json;
      };
      reset_room: { Args: { p_room_id: string }; Returns: undefined };
      reset_user_stats: { Args: { p_user_id: string }; Returns: undefined };
      send_reaction: {
        Args: { p_emoji: string; p_player_id: string; p_room_id: string };
        Returns: Json;
      };
      send_room_message: {
        Args: { p_player_id: string; p_room_id: string; p_text: string };
        Returns: Json;
      };
      start_game: { Args: { p_room_id: string }; Returns: Json };
      start_shuffling: { Args: { p_room_id: string }; Returns: Json };
      submit_bot_definitions_bulk: {
        Args: { p_room_id: string; p_round: number; p_rows: Json };
        Returns: Json;
      };
      submit_daily_attempt: {
        Args: { p_guess: string; p_time_seconds: number; p_user_id: string };
        Returns: Json;
      };
      submit_daily_attempt_scored: {
        Args: {
          p_guess: string;
          p_similarity: number;
          p_time_seconds: number;
          p_user_id: string;
        };
        Returns: Json;
      };
      submit_definition: {
        Args: { p_player_id: string; p_room_id: string; p_text: string };
        Returns: Json;
      };
      tick_stalled_rooms: { Args: never; Returns: Json };
      xp_to_level: { Args: { p_xp: number }; Returns: number };
    };
    Enums: {
      app_role: "admin" | "moderator" | "user";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<
  keyof Database,
  "public"
>];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "moderator", "user"],
    },
  },
} as const;
