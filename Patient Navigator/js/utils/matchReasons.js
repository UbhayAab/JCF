// ============================================================
// Patient Navigator: showing the mentor WHY
//
// match_resources() returns keys, never sentences, so the same decision can
// be rendered to a mentor in English and to a family in Hindi without either
// one reading the other's register. These are the MENTOR's words. They are
// deliberately not in js/i18n/: the staff console stays in English, and a
// mentor needs "no ration card on file", where the family needs "they will
// ask for a ration card, and you told us you do not have one".
//
// The point of surfacing all of this is override. The database does not know
// that this particular family's neighbour works at that dharamshala, and the
// mentor does. So an excluded row is still shown, greyed, with the reason,
// and can be ticked anyway.
// ============================================================

import { DOC_LABELS } from './docTypes.js';

// Hard exclusions. Why this will not be sent unless the mentor insists.
const EXCLUDED = {
  too_old_for_this:          'Above their age limit',
  too_young_for_this:        'Below their age limit',
  serves_other_gender:       'Serves the other gender only',
  not_a_resident_of_that_state: 'Only for residents of another state',
  wrong_city_for_their_treatment: 'Not in the city they are treated in',
  not_taking_anyone:         'Full or closed',
  costs_more_than_they_have: 'Costs more than the family said they have',
  not_enough_known_about_it: 'Too little known about this row to send it safely',
};

// Warnings. The family should be told, but this may still be the right answer.
const BLOCKERS = {
  papers_never_asked_about: 'We have never asked this family what papers they hold',
  must_go_in_person:        'Needs someone to go there in person',
  phone_never_answered:     'Nobody has ever answered this number',
  phone_hard_to_reach:      'Phone is answered only sometimes',
  waiting_list:             'On a waiting list',
  free_rooms_fill_up:       'Free rooms, usually full',
  never_phoned_by_us:       'Never phoned by us, only imported',
  not_checked_in_a_year:    'Not confirmed for over a year',
  takes_weeks:              'Takes more than two weeks',
  no_phone_number:          'No phone number on file',
  treatment_city_unknown:   'We do not know which hospital they attend, so the city was not checked',
};

// Why it is on the list.
const REASONS = {
  costs_nothing:          'Free',
  within_their_budget:    'Within what they can pay',
  near_their_treatment:   'In the city they are treated in',
  their_own_state_scheme: 'Their own state runs it',
  open_across_india:      'Open across India',
  age_fits:               'Age fits',
  they_have_every_paper:  'They hold every paper it asks for',
  phone_gets_answered:    'Phone gets answered',
  space_when_we_checked:  'Had space when we last checked',
  attendant_allowed:      'An attendant can stay too',
};

const FIT = {
  ready:           { label: 'Ready to send',        tone: 'ok' },
  needs_documents: { label: 'Needs a paper',        tone: 'warn' },
  needs_a_visit:   { label: 'Needs a visit',        tone: 'warn' },
  may_be_full:     { label: 'May be full',          tone: 'warn' },
  hard_to_reach:   { label: 'Hard to reach',        tone: 'warn' },
  unconfirmed:     { label: 'Never confirmed by us', tone: 'neutral' },
  ruled_out:       { label: 'Ruled out',            tone: 'danger' },
};

export const fitBadge = (fit) => FIT[fit] || FIT.unconfirmed;

export function reasonLabel(key) {
  if (!key) return '';
  if (key.startsWith('missing_document:')) {
    const d = key.split(':')[1];
    return 'No ' + (DOC_LABELS[d] || d).toLowerCase() + ' on file';
  }
  return EXCLUDED[key] || BLOCKERS[key] || REASONS[key] || key.replace(/_/g, ' ');
}

export const reasonLabels = (keys) => (keys || []).map(reasonLabel).filter(Boolean);
