-- b33_oracle.lua -- B33 read-side ORACLE for animal trainer-assignment (DF's "Assign a trainer
-- to this creature" action). Dumps the LIVE plotinfo.training.training_assignments vector -- the
-- exact struct the plugin's assign-trainer / unassign-trainer writes (src/info_panel.cpp
-- set_trainer + Units::unassignTrainer). Its output is the ground truth the HTTP mutations must
-- match, animal-for-animal.
--   Run under dfhack:  dfhack-run lua -f <ABSOLUTE path to this file>
-- (per the ops note: lua -f + ABSOLUTE path; inline multi-statement lua fails. This is a ONE-SHOT
--  read -- a single pass over a small in-memory vector, NOT a poll loop.)
--
-- Field contract (df/training_assignment.h + unit_animal_training_info_flag.h):
--   animal_id  : the tamed/trained animal unit id (vector is kept sorted by this)
--   trainer_id : assigned trainer unit id, or -1 when "any trainer"
--   flags.bits.any_trainer / train_war / train_hunt
-- A PLAIN taming assignment (B33's assign-trainer) has train_war=0 AND train_hunt=0
-- (that is what Units::isMarkedForTaming keys on); war/hunt (B16) set one of those bits.

local vec = df.global.plotinfo.training.training_assignments
print("=== B33 trainer-assignment oracle: plotinfo.training.training_assignments ===")
print(string.format("count=%d", #vec))
for i = 0, #vec - 1 do
  local a = vec[i]
  local f = a.flags
  print(string.format(
    "ASG animal_id=%d trainer_id=%d any_trainer=%s train_war=%s train_hunt=%s taming=%s",
    a.animal_id, a.trainer_id,
    tostring(f.any_trainer), tostring(f.train_war), tostring(f.train_hunt),
    tostring(f.train_war == false and f.train_hunt == false)))
end
if #vec == 0 then
  print("NOTE: no animals are marked for training/taming right now. Assign a trainer to a")
  print("      tameable animal (web Pets tab, or POST /livestock-action?...&action=assign-trainer)")
  print("      then re-run to see its row here.")
end
