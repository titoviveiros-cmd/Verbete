// Confere no banco vivo se a fórmula de pontuação é a ORIGINAL (+3/+1/+2/+3/-1)
import pg from "pg";

const client = new pg.Client({ connectionString: process.env.DB_URL, ssl: { rejectUnauthorized: false } });
await client.connect();

const { rows: [avr] } = await client.query(
  `SELECT prosrc LIKE '%p.score + 3%' AS truth_plus3,
          prosrc LIKE '%score + 2%'   AS coord_plus2,
          prosrc LIKE '%score + r.votes WHERE%' AS fake_plus1_per_vote,
          prosrc NOT LIKE '%+ 100%' AND prosrc NOT LIKE '%* 50%' AS sem_valores_v2
   FROM pg_proc WHERE proname = 'advance_voting_to_reveal'`,
);
const { rows: [bonus] } = await client.query(
  `SELECT prosrc LIKE '%p.score + 3%' AS bonus_plus3 FROM pg_proc WHERE proname = 'apply_similarity_bonus'`,
);
const { rows: [ext] } = await client.query(
  `SELECT prosrc LIKE '%GREATEST(score - 1, 0)%' AS penalidade_menos1 FROM pg_proc WHERE proname = 'extend_writing_or_advance'`,
);
console.log("advance_voting_to_reveal:", JSON.stringify(avr));
console.log("apply_similarity_bonus:", JSON.stringify(bonus));
console.log("extend_writing_or_advance:", JSON.stringify(ext));
await client.end();
